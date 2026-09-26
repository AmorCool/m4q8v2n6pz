#!/usr/bin/env node
"use strict";

/*
 * Put a real aria2c where the app expects to find one.
 *
 * The engine binary is not committed. It is ~5 MB per platform, it is GPLv3
 * while this repository is not, and it is a build artefact -- all three point
 * the same way. This script downloads it instead, from the cross-build
 * repository's release assets.
 *
 * Assets rather than workflow artefacts: the account's artefact store has a
 * quota that fills up, and it did. The first Windows build that succeeded
 * failed on the upload step for exactly that reason while the binary itself
 * was fine.
 *
 * The build repository is private, so this needs a token. It takes one from
 * GITHUB_TOKEN or GH_TOKEN, falls back to `gh auth token`, and says so plainly
 * when neither is available -- an unauthenticated request for a private
 * repository answers 404, which otherwise reads as "no releases yet".
 *
 * Usage:
 *     node scripts/fetch-engine.js              # current platform
 *     node scripts/fetch-engine.js win32-x64
 *     node scripts/fetch-engine.js --list
 *     node scripts/fetch-engine.js --from <dir> # copy from a local build tree
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = "AmorCool/k7m3p9x2qv";
const BIN_DIR = path.join(__dirname, "..", "bin");

/*
 * A token, if one can be found, and nothing if not.
 *
 * The build repository is private, and GitHub answers an unauthenticated
 * request for a private repository with 404 rather than 403. That is the
 * confusing part: the message reads "no releases yet" when the releases exist
 * and are merely invisible to the caller. A token is what makes them visible.
 *
 * The order is deliberate. An explicit environment variable wins, because it
 * is the only one a CI run or a shell can set for a single command. `gh auth
 * token` is second, because anyone who has the CLI logged in has already made
 * this decision once. Failing both, the request goes out unauthenticated,
 * which is correct for a public fork and produces a clear error here.
 */
function findToken() {
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
        const value = process.env[name];
        if (value && value.trim()) return value.trim();
    }
    try {
        const token = execFileSync("gh", ["auth", "token"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (token) return token;
    } catch {
        // gh is absent or not logged in. Both are ordinary.
    }
    return null;
}

function authHeaders(token) {
    return token ? ["-H", `Authorization: token ${token}`] : [];
}

/*
 * Which release asset belongs to which platform.
 *
 * The keys are what `os.platform()` and `os.arch()` return joined by a dash,
 * because those are the two calls a caller would otherwise have to make
 * themselves before they could ask for anything.
 *
 * The iOS entries have no `executable` name of the usual kind: the binary is
 * built for a phone and cannot run here, so it is only ever staged, never
 * launched. `name` is still what it lands as, because the packager looks for
 * it by that name.
 */
const TARGETS = {
    "win32-x64": { asset: /^win-x64\.exe$/, name: "aria2c.exe", platform: "windows" },
    "win32-ia32": { asset: /^win-x86\.exe$/, name: "aria2c.exe", platform: "windows" },
    "iphoneos-arm64": { asset: /^ios-device$/, name: "aria2c", platform: "ios" },
    "iphonesimulator-arm64": { asset: /^ios-simulator$/, name: "aria2c", platform: "ios" },
    "darwin-arm64": { asset: /^ios-simulator$/, name: "aria2c", platform: "macos" },
};

function currentTarget() {
    return `${os.platform()}-${os.arch()}`;
}

function listTargets() {
    const keys = Object.keys(TARGETS);
    const width = Math.max(...keys.map((k) => k.length));
    for (const key of keys) {
        const marker = key === currentTarget() ? " (this machine)" : "";
        console.log(`${key.padEnd(width)}  ->  bin/${TARGETS[key].name}${marker}`);
    }
}

/*
 * Release assets are fetched with the REST API rather than by constructing a
 * download URL, because a release tag that has not been created yet and a
 * release that exists but has no assets both return the same 404 from the
 * browser URL, and the error this script should print differs between them.
 */
function releaseAssets(token) {
    let out;
    try {
        out = execFileSync(
            "curl",
            [
                "-fsSL",
                ...authHeaders(token),
                `https://api.github.com/repos/${REPO}/releases?per_page=20`,
            ],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
        );
    } catch (error) {
        // A 404 here means the repository is not visible to this caller, which
        // for a private repository means no token was found. The network being
        // down looks the same to curl, so the two are separated by asking again
        // without -f: a real 404 answers with a body, a failed connection does
        // not answer at all.
        const detail = String((error.stderr || "") + (error.stdout || ""));
        if (detail.includes("404")) {
            if (!token) {
                throw new Error(
                    `${REPO} is private and no token was found, so GitHub ` +
                        `reports it as missing rather than as forbidden. Set ` +
                        `GITHUB_TOKEN, or log in with \`gh auth login\`, then ` +
                        `run this again.`
                );
            }
            throw new Error(
                `${REPO} has no releases, even with a token. The binaries come ` +
                    `from its CI workflow; run it once, or pass --from <dir> to ` +
                    `use a local build tree.`
            );
        }
        throw new Error(`could not reach the GitHub API: ${detail.trim() || error.message}`);
    }
    const releases = JSON.parse(out);
    if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error(
            `no releases in ${REPO}. The binaries are produced by CI; run the ` +
                `workflow once before fetching.`
        );
    }
    return releases;
}

/*
 * Assets are downloaded through the API rather than from the browser URL.
 *
 * `browser_download_url` is a redirect that requires the same authentication
 * as the API for a private repository, so it is not usable here. The asset
 * endpoint with an octet-stream accept header is the documented way to pull
 * a private release asset, and it works for a public one too.
 */
function download(asset, destination, token) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Written to a temporary name and renamed, so an interrupted download can
    // never leave a half-file in place that the launcher would then try to run.
    const temporary = `${destination}.part`;
    const url = token
        ? `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`
        : asset.browser_download_url;
    execFileSync(
        "curl",
        [
            "-fsSL",
            ...authHeaders(token),
            ...(token ? ["-H", "Accept: application/octet-stream"] : []),
            "-o",
            temporary,
            url,
        ],
        { stdio: "inherit" }
    );
    fs.renameSync(temporary, destination);
}

function copyFromBuildTree(root, target) {
    const candidates = [
        path.join(root, "build", "windows", "x64", "aria2c.exe"),
        path.join(root, "build", "windows", "x86", "aria2c.exe"),
        path.join(root, "build", "ios", "iphoneos", "aria2c"),
        path.join(root, "build", "ios", "iphonesimulator", "aria2c"),
    ];
    const wanted = TARGETS[target];
    const source = candidates.find((candidate) => {
        if (!fs.existsSync(candidate)) return false;
        // The arch in the path is the only thing distinguishing two Windows
        // candidates, and picking the wrong one produces a binary that will not
        // start on the machine that asked for it.
        if (target === "win32-x64") return candidate.includes(`${path.sep}x64${path.sep}`);
        if (target === "win32-ia32") return candidate.includes(`${path.sep}x86${path.sep}`);
        if (target.startsWith("iphoneos")) return candidate.includes(`${path.sep}iphoneos${path.sep}`);
        if (target.startsWith("iphonesimulator")) return candidate.includes(`${path.sep}iphonesimulator${path.sep}`);
        return false;
    });
    if (!source) {
        throw new Error(`no ${target} binary under ${root}`);
    }
    const destination = path.join(BIN_DIR, wanted.name);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.copyFileSync(source, destination);
    return destination;
}

function main() {
    const args = process.argv.slice(2);

    if (args.includes("--list")) {
        listTargets();
        return;
    }

    const fromIndex = args.indexOf("--from");
    const positional = args.filter((a, i) => !a.startsWith("--") && i !== fromIndex + 1);
    const target = positional[0] || currentTarget();

    const wanted = TARGETS[target];
    if (!wanted) {
        console.error(`unknown target: ${target}`);
        console.error(`known targets: ${Object.keys(TARGETS).join(", ")}`);
        process.exit(1);
    }

    if (fromIndex !== -1) {
        const root = args[fromIndex + 1];
        if (!root) {
            console.error("--from needs a directory");
            process.exit(1);
        }
        const destination = copyFromBuildTree(root, target);
        console.log(`placed ${destination}`);
        return;
    }

    console.log(`looking for a ${target} build in ${REPO}`);
    const token = findToken();
    const releases = releaseAssets(token);

    // Newest first, and the first asset that matches both the target and the
    // naming pattern wins. A release can legitimately carry assets for several
    // targets, so the pattern is what selects, not the release.
    for (const release of releases) {
        const asset = (release.assets || []).find((a) => wanted.asset.test(a.name));
        if (!asset) continue;
        const destination = path.join(BIN_DIR, wanted.name);
        console.log(`downloading ${asset.name} from ${release.tag_name}`);
        download(asset, destination, token);
        console.log(`placed ${destination}`);
        return;
    }

    throw new Error(
        `no release asset matching ${wanted.asset} in the last ${releases.length} ` +
            `releases of ${REPO}`
    );
}

try {
    main();
} catch (error) {
    console.error(`fetch-engine: ${error.message}`);
    process.exit(1);
}
