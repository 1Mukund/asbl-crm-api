/**
 * Dashboard authentication — login / registration / approval / sessions.
 *
 * Collection: "dashboard_users" in "Zoho_Database" Mongo db.
 *   { _id: email, email, password_hash: "salt:hash", role: "admin"|"user",
 *     status: "pending"|"approved"|"rejected", created_at, approved_at,
 *     approved_by }
 *
 * Sessions are stateless signed cookies (HMAC-SHA256 over
 * "email|role|expiryMs" using INHOUSE_POSTHOOK_SECRET as the key). No
 * server-side session store needed — verify the signature on each request.
 *
 * Admin bootstrap: admin@asblloft.com is seeded on first touch with a
 * scrypt hash of the password (the plaintext NEVER appears in the repo —
 * only the precomputed salt:hash below). Admin can change it later.
 *
 * Passwords: Node stdlib scrypt (no external bcrypt dependency).
 */

import crypto from "crypto";
import { getCollection, COL } from "./mongo";

const SESSION_SECRET = process.env.INHOUSE_POSTHOOK_SECRET || "asbl-dashboard-fallback-secret-change-me";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "asbl_dash_session";

export const ADMIN_EMAIL = "admin@asblloft.com";
// scrypt salt:hash of the admin password — plaintext is NOT stored anywhere.
const ADMIN_SEED_HASH =
  "7b9d0e78faffc71aaa94b6bd69127512:d0502b858e2abb77dd7b8d1794fd25071cd7611000746c896dab92cfe4f3fda15a7eb519733f90188273bb0afce8ed3420007a673c2d1a019b35c4531ac5ca63";

export type UserRole = "admin" | "user";
export type UserStatus = "pending" | "approved" | "rejected";

export interface DashboardUser {
  _id: string;       // email
  email: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  approved_at?: string | null;
  approved_by?: string | null;
}

// ─── Password hashing (scrypt) ─────────────────────────────────────────────

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(plain, salt, 64).toString("hex");
    // constant-time compare
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(candidate, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Admin bootstrap ───────────────────────────────────────────────────────

let _adminSeeded = false;
export async function ensureAdminSeeded(): Promise<void> {
  if (_adminSeeded) return;
  try {
    const col = await getCollection<DashboardUser>(COL_USERS);
    const existing = await col.findOne({ _id: ADMIN_EMAIL as any });
    if (!existing) {
      await col.updateOne(
        { _id: ADMIN_EMAIL as any },
        {
          $setOnInsert: {
            _id: ADMIN_EMAIL,
            email: ADMIN_EMAIL,
            password_hash: ADMIN_SEED_HASH,
            role: "admin",
            status: "approved",
            created_at: new Date().toISOString(),
            approved_at: new Date().toISOString(),
            approved_by: "system",
          } as any,
        },
        { upsert: true },
      );
      console.log(`[dashboard_auth] seeded admin ${ADMIN_EMAIL}`);
    }
    _adminSeeded = true;
  } catch (err: any) {
    console.error(`[dashboard_auth] ensureAdminSeeded failed: ${err.message}`);
  }
}

// Collection name (not in COL since auth is dashboard-specific)
const COL_USERS = "dashboard_users";

// ─── User CRUD ─────────────────────────────────────────────────────────────

function normEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export async function getUser(email: string): Promise<DashboardUser | null> {
  const e = normEmail(email);
  if (!e) return null;
  try {
    const col = await getCollection<DashboardUser>(COL_USERS);
    return await col.findOne({ _id: e as any });
  } catch (err: any) {
    console.error(`[dashboard_auth] getUser failed: ${err.message}`);
    return null;
  }
}

export async function registerUser(
  email: string,
  plainPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const e = normEmail(email);
  if (!e || !e.includes("@")) return { ok: false, error: "Valid email required" };
  if (!plainPassword || plainPassword.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters" };
  }
  try {
    const existing = await getUser(e);
    if (existing) return { ok: false, error: "An account with this email already exists" };
    const col = await getCollection<DashboardUser>(COL_USERS);
    await col.insertOne({
      _id: e,
      email: e,
      password_hash: hashPassword(plainPassword),
      role: "user",
      status: "pending",
      created_at: new Date().toISOString(),
      approved_at: null,
      approved_by: null,
    } as any);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function listUsers(): Promise<DashboardUser[]> {
  try {
    const col = await getCollection<DashboardUser>(COL_USERS);
    return await col.find({}).sort({ created_at: -1 }).toArray();
  } catch (err: any) {
    console.error(`[dashboard_auth] listUsers failed: ${err.message}`);
    return [];
  }
}

export async function setUserStatus(
  email: string,
  status: UserStatus,
  approvedBy: string,
): Promise<boolean> {
  const e = normEmail(email);
  if (!e) return false;
  try {
    const col = await getCollection<DashboardUser>(COL_USERS);
    const r = await col.updateOne(
      { _id: e as any },
      {
        $set: {
          status,
          approved_at: new Date().toISOString(),
          approved_by: approvedBy,
        },
      },
    );
    return r.matchedCount > 0;
  } catch (err: any) {
    console.error(`[dashboard_auth] setUserStatus failed: ${err.message}`);
    return false;
  }
}

// ─── Login ─────────────────────────────────────────────────────────────────

export async function authenticate(
  email: string,
  plainPassword: string,
): Promise<{ ok: boolean; user?: DashboardUser; error?: string }> {
  await ensureAdminSeeded();
  const user = await getUser(email);
  if (!user) return { ok: false, error: "No account with this email" };
  if (!verifyPassword(plainPassword, user.password_hash)) {
    return { ok: false, error: "Incorrect password" };
  }
  if (user.status !== "approved") {
    return { ok: false, error: `Account is ${user.status} — an admin must approve it before you can log in` };
  }
  return { ok: true, user };
}

// ─── Session cookie (stateless, HMAC-signed) ──────────────────────────────

export interface Session {
  email: string;
  role: UserRole;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

export function createSessionToken(email: string, role: UserRole): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${email}|${role}|${expiry}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}|${sig}`).toString("base64");
}

export function verifySessionToken(token: string): Session | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split("|");
    if (parts.length !== 4) return null;
    const [email, role, expiryStr, sig] = parts;
    const payload = `${email}|${role}|${expiryStr}`;
    if (sign(payload) !== sig) return null;            // tampered
    if (Date.now() > Number(expiryStr)) return null;   // expired
    return { email, role: role as UserRole };
  } catch {
    return null;
  }
}

/** Parse the session cookie from a raw Cookie header. */
export function getSessionFromCookies(cookieHeader: string | undefined): Session | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const match = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
  return verifySessionToken(token);
}

/** Set-Cookie header value to establish a session. */
export function buildSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Set-Cookie header value to clear the session (logout). */
export function buildLogoutCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
