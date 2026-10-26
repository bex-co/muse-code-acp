import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execSupportsPermissionProfile, probeSdkHost } from "../muse-host.js";
import { MODES } from "../modes.js";

function fakeMuse(version: string, execHelp: string): string {
  const binary = join(mkdtempSync(join(tmpdir(), "muse-exec-profile-")), "muse");
  writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo "Muse Code ${version}"; exit 0; fi\n` +
      `if [ "$1" = exec ]; then echo '${execHelp}'; exit 0; fi\nexit 0\n`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

it("uses exec permission profiles only on hosts that list the flag from 1.4.4", () => {
  const help = "--permission-profile <ID>";
  expect(execSupportsPermissionProfile({}, fakeMuse("1.4.4 (1.4.4-R5419.1)", help))).toBe(true);
  expect(execSupportsPermissionProfile({}, fakeMuse("1.5.0", help))).toBe(true);
  expect(execSupportsPermissionProfile({}, fakeMuse("1.4.3 (1.4.3-R5018.1)", help))).toBe(false);
  expect(execSupportsPermissionProfile({}, fakeMuse("1.4.4", "--model <ID>"))).toBe(false);
  // Each probe spawns the fake binary several times; allow for loaded CI hosts.
}, 30_000);

it("selects :read-only only for the modes that already disable writes and shell", () => {
  for (const mode of Object.values(MODES))
    expect(mode.execProfile, mode.id).toBe(
      mode.id === "readOnly" || mode.id === "plan" ? ":read-only" : undefined,
    );
});

it("does not cache a host probe that could not run", () => {
  const binary = join(mkdtempSync(join(tmpdir(), "muse-probe-retry-")), "muse");
  // Missing binary: the spawn fails, which must not stick as "no host".
  expect(probeSdkHost({}, binary).version).toBeNull();
  writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo "Muse Code 1.4.13"; fi\nexit 0\n`,
  );
  chmodSync(binary, 0o755);
  expect(probeSdkHost({}, binary).version).toBe("1.4.13");
});
