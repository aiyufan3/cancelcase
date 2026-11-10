import { randomBytes } from "node:crypto";
import type { Environment } from "@/domain/types";

const PREFIX: Record<Environment, string> = { fixture: "fx", sandbox: "sb" };

/**
 * Opaque identifiers carry the environment so a fixture record can never be mistaken for
 * a Sandbox record, even in logs. Example: fx_case_3f9a1c2b7d.
 */
export function newId(environment: Environment, kind: string): string {
  return `${PREFIX[environment]}_${kind}_${randomBytes(6).toString("hex")}`;
}

export function idEnvironment(id: string): Environment | null {
  if (id.startsWith("fx_")) return "fixture";
  if (id.startsWith("sb_")) return "sandbox";
  return null;
}

export function assertIdEnvironment(id: string, environment: Environment, what: string): void {
  const env = idEnvironment(id);
  if (env !== environment) {
    throw new Error(`${what} ${id} does not belong to the ${environment} environment.`);
  }
}
