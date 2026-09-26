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

const REPO = "AmorCool/aria2-cross";
const BIN_DIR = path.join(__dirname, "..", "bin");

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
    "win32-x64": { asset: /^aria2c-x64\.exe$/, name: "aria2c.exe", platform: "windows" },
    "win32-ia32": { asset: /^aria2c-x86\.exe$/, name: "aria2c.exe", platform: "windows" },
    "iphoneos-arm64": { asset: /^aria2c-ios-device$/, name: "aria2c", platform: "ios" },
    "iphonesimulator-arm64": { asset: /^aria2c-ios-simulator$/, name: "aria2c", platform: "ios" },
    "darwin-arm64": { asset: /^aria2c-ios-simulator$/, name: "aria2c", platform: "macos" },
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
function releaseAssets() {
    let out;
    try {
        out = execFileSync(
            "curl",
            ["-fsSL", `https://api.github.com/repos/${REPO}/releases?per_page=20`],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
        );
    } catch (error) {
        // A 404 here means the repository has no releases yet, not that the
        // network is down, and those two call for different responses. curl
        // reports both as a non-zero exit.
        const detail = String((error.stderr || "") + (error.stdout || ""));
        if (detail.includes("404")) {
            throw new Error(
                `${REPO} has no releases yet. The binaries come from its CI ` +
                    `workflow; run it once, or pass --from <dir> to use a local ` +
                    `build tree.`
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

function download(url, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Written to a temporary name and renamed, so an interrupted download can
    // never leave a half-file in place that the launcher would then try to run.
    const temporary = `${destination}.part`;
    execFileSync("curl", ["-fsSL", "-o", temporary, url], { stdio: "inherit" });
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
    const releases = releaseAssets();

    // Newest first, and the first asset that matches both the target and the
    // naming pattern wins. A release can legitimately carry assets for several
    // targets, so the pattern is what selects, not the release.
    for (const release of releases) {
        const asset = (release.assets || []).find((a) => wanted.asset.test(a.name));
        if (!asset) continue;
        const destination = path.join(BIN_DIR, wanted.name);
        console.log(`downloading ${asset.name} from ${release.tag_name}`);
        download(asset.browser_download_url, destination);
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
