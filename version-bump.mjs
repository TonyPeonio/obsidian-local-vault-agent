import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
// The beta manifest follows every release, stable or beta (see README, "Beta channel").
writeFileSync("manifest-beta.json", JSON.stringify(manifest, null, "\t") + "\n");

// A pre-release version (0.9.0-beta.1) stops here: the community store reads manifest.json and
// versions.json on main, so writing a beta into them would offer it to every store user.
if (!targetVersion.includes("-")) {
	writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}
