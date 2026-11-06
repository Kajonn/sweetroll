// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("uses the public Ubuntu archive for source files and mirror-transport lists", () => {
  const root = mkdtempSync(join(tmpdir(), "sweetroll-apt-"));
  const script = fileURLToPath(new URL("../../scripts/ci-browser-deps.sh", import.meta.url));
  const old = "http://azure.archive.ubuntu.com/ubuntu", target = "https://archive.ubuntu.com/ubuntu";
  const fixtures = {
    "sources.list": `deb ${old} resolute main\n`,
    "sources.list.d/ubuntu.sources": `Types: deb\nURIs: ${old}\nSuites: resolute\n`,
    "apt-mirrors.txt": `${old}\nhttps://archive.ubuntu.com/ubuntu\n`,
    "apt-mirrors-security.txt": `${old}\nhttps://security.ubuntu.com/ubuntu\n`,
  };
  try {
    mkdirSync(join(root,"sources.list.d"));
    for (const [path,content] of Object.entries(fixtures)) writeFileSync(join(root,path),content);
    writeFileSync(join(root,"unrelated.txt"),old);
    execFileSync("bash",[script,root]);
    for (const [path,content] of Object.entries(fixtures)) expect(readFileSync(join(root,path),"utf8"),path).toBe(content.replaceAll(old,target));
    expect(readFileSync(join(root,"unrelated.txt"),"utf8")).toBe(old);
    expect(readFileSync(join(root,"apt.conf.d/80-sweetroll-ci"),"utf8")).toContain('Acquire::https::Timeout "30";');
    execFileSync("bash",[script,root]);
    expect(readFileSync(join(root,"apt-mirrors.txt"),"utf8")).toBe(fixtures["apt-mirrors.txt"].replaceAll(old,target));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
