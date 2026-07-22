import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const source = path.join(root, "src");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function filesBelow(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(full) : [full];
  });
}

const orphaned = filesBelow(dist)
  .filter((file) => file.endsWith(".js"))
  .filter((file) => {
    const relative = path.relative(dist, file).replace(/\.js$/, "");
    return (
      !fs.existsSync(path.join(source, `${relative}.ts`)) &&
      !fs.existsSync(path.join(source, `${relative}.tsx`))
    );
  })
  .map((file) => path.relative(root, file));

if (orphaned.length > 0) {
  throw new Error(`Orphaned compiled files found:\n${orphaned.join("\n")}`);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-package-"));
try {
  for (const file of ["LICENSE", "README.md", "package-lock.json", "package.json", "usage.kdl"]) {
    fs.copyFileSync(path.join(root, file), path.join(staging, file));
  }
  fs.cpSync(dist, path.join(staging, "dist"), { recursive: true });

  execFileSync(npm, ["ci", "--ignore-scripts", "--omit=dev"], {
    cwd: staging,
    stdio: "inherit",
  });

  const sdkPackagePath = path.join(
    staging,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "package.json",
  );
  const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (!sdkPackage.dependencies?.["@hono/node-server"]) {
    throw new Error("MCP SDK no longer declares @hono/node-server; review bundling policy");
  }
  sdkPackage.dependencies["@hono/node-server"] = "^2.0.11";
  fs.writeFileSync(sdkPackagePath, `${JSON.stringify(sdkPackage, null, 2)}\n`);

  const output = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: staging,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output) as Array<{
    bundled: string[];
    files: Array<{ path: string }>;
  }>;
  const allowedRoots = new Set(["LICENSE", "README.md", "package.json", "usage.kdl"]);
  const unexpected = pack.files
    .map((entry) => entry.path)
    .filter(
      (file) =>
        !file.startsWith("dist/") && !file.startsWith("node_modules/") && !allowedRoots.has(file),
    );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected package files found:\n${unexpected.join("\n")}`);
  }
  for (const dependency of ["@modelcontextprotocol/sdk", "@hono/node-server"]) {
    if (!pack.bundled.includes(dependency)) {
      throw new Error(`Required patched dependency is not bundled: ${dependency}`);
    }
  }

  const destinationFlag = process.argv.indexOf("--pack-destination");
  if (destinationFlag >= 0) {
    const destination = process.argv[destinationFlag + 1];
    if (!destination) throw new Error("--pack-destination requires a directory");
    fs.mkdirSync(destination, { recursive: true });
    const tarball = execFileSync(
      npm,
      ["pack", "--ignore-scripts", "--pack-destination", path.resolve(destination)],
      { cwd: staging, encoding: "utf8" },
    ).trim();
    process.stdout.write(`${path.resolve(destination, tarball)}\n`);
  } else {
    process.stdout.write(
      `Package check passed: ${pack.files.length} files, patched MCP SDK bundled, no orphaned output.\n`,
    );
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
