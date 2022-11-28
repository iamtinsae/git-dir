#!/usr/bin/env node
import fetch from "node-fetch";
import cliProgress from "cli-progress";
import fs from "fs";
import path from "path";
import pMap from "p-map";
import pRetry from "p-retry";
import { ArgumentParser } from "argparse";

const URL_REGEX = /^[/]([^/]+)[/]([^/]+)[/]tree[/]([^/]+)[/](.*)/;

const githubApi = async (endpoint, token) => {
  const resp = await fetch(`https://api.github.com/repos/${endpoint}`, {
    headers: {
      Authorization: token ? `Bearer ${token}` : null,
    },
  });

  switch (resp.status) {
    case 200:
      return { data: await resp.json() };

    case 401:
      return {
        error: true,
        message: token
          ? "Token provided has expired or been revoked."
          : "Token must be provided to access this repo.",
      };

    case 403:
      return { error: true, message: "Rate limit exceeded!" };

    case 404:
      return { error: true, message: "Repository not found!" };

    default:
      return { error: true, message: "Unknown error occurred!" };
  }
};

const getContentFromUrl = async (url, token, signal) => {
  const resp = await fetch(url, {
    headers: {
      Authorization: token ? `Bearer ${token}` : null,
    },
    signal,
  });

  if (resp.status !== 200) {
    throw new Error(`Reading blob from ${url} failed.`);
  }

  const { content } = await resp.json();
  return content;
};

const downloadDirectory = async ({
  user,
  repository,
  ref,
  dir,
  token,
  outputDir,
}) => {
  if (!ref) ref = "HEAD";
  if (!dir.endsWith("/")) dir = `${dir}/`;

  const { error, message, data } = await githubApi(
    `${user}/${repository}/git/trees/${ref}?recursive=1`,
    token
  );

  if (error) {
    console.warn(message);
    process.exit(1);
  }

  const { tree = [], truncated } = data;
  if (truncated) {
    console.warn(
      "Directory seems too long, and has been truncated by the github api."
    );
  }

  const progressBar = new cliProgress.SingleBar();
  const abortController = new AbortController();
  const downloads = [];
  const failedDownloads = [];

  for (const file of tree) {
    if (file.type === "blob" && file.path.startsWith(dir)) {
      downloads.push(file);
    }
  }

  progressBar.start(downloads.length, 0, {
    speed: "N/A",
  });

  const downloadFile = async (file) => {
    const fullPath = path.join(outputDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const blob = await pRetry(
      () => getContentFromUrl(file.url, token, abortController.signal),
      {
        retries: 5,
        onFailedAttempt: (error) => {
          console.warn(
            `Download failed for file ${file.path} failed ${error.attemptNumber} times. ${error.retriesLeft} attemps remaining.`
          );
        },
      }
    );

    fs.writeFile(
      `${fullPath}`,
      blob,
      {
        encoding: "base64",
      },
      (err) => {
        if (err) {
          failedDownloads.push(file);
          console.warn(`Downloading ${file.path} failed. Retrying...`);
          throw new Error(`Downloading ${file.path} failed!`);
        }
      }
    );
    progressBar.increment();
  };

  await pMap(downloads, downloadFile, {
    concurrency: 10,
  }).catch((error) => {
    console.warn(error.message);
    abortController.abort();
  });
  progressBar.stop();

  failedDownloads.forEach((file) =>
    console.warn(`Downloading ${file.path} failed!.`)
  );
};

const getRepoInfo = async (repo) => {
  return githubApi(repo);
};

async function download(url, outputDir) {
  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    console.warn(`Invalid url \`${url}\` given!`);
    return;
  }

  const token = process.env["TOKEN"];

  if (!token)
    console.warn(
      "TOKEN not found in environment. Recommended to use to avoid rate limit exceeded error."
    );

  const [, user, repository, ref, dir] = URL_REGEX.exec(parsedUrl.pathname);

  const { error, message, data } = await getRepoInfo(`${user}/${repository}`);

  if (error) {
    console.warn(message);
    return process.exit(1);
  }

  const { full_name, description, stargazers_count, language, license } = data;

  console.log(`Repository Name:\t${full_name}
Description:\t\t${description}
Stars:\t\t\t${stargazers_count}
Primary Language:\t${language}
License:\t\t${license ? license.name : "None"}
  `);

  console.log("Getting repo directory info...");

  if (fs.existsSync(path.join(outputDir, dir))) {
    console.warn(`A folder already exists with name ${dir}.\nExiting...`);
    process.exit(1);
  }

  downloadDirectory({
    user,
    repository,
    ref,
    dir,
    token,
    outputDir,
  });
}

const parser = new ArgumentParser({
  description: "Download any public github repo directory.",
});

parser.add_argument("urls", {
  type: String,
  nargs: "+",
  help: "List of urls",
});

parser.add_argument("-o", "--out", {
  type: String,
  help: "Output directory",
  default: process.cwd(),
});

const args = parser.parse_args();

args.urls.forEach((url) => download(url, args.out));
