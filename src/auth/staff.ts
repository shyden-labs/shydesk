import type { D1Database } from '@cloudflare/workers-types';
import type { MiddlewareHandler } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import type { Env } from '../env.ts';
import { verifyAccess, type AccessEnv } from './access.ts';

/**
 * Roles and product scope (shyden-labs/shydesk#16; design: Roles). An admin
 * sees every product; a rep sees only the products granted to them. Isolation
 * is enforced here on the server, for every query, not by hiding things in the page.
 */

export type Role = 'admin' | 'rep';

export interface Staff {
  email: string;
  role: Role;
  /** The products this person may see: every product for an admin, the grants for a rep. */
  products: string[];
}

/** The bindings a staff route needs. Joins `Env` when the desk is wired to Access. */
export interface StaffEnv extends Env, AccessEnv {
  /** The first admin, who is admin with no staff row, so a new install can be set up. */
  FIRST_ADMIN_EMAIL: string;
}

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Loads a signed-in person's role and products, or null if they are not staff.
 * Emails match whatever their stored case. A row with a role this code does not
 * know is treated as no row, so a bad value never grants anything.
 */
export async function loadStaff(db: D1Database, email: string, firstAdmin: string): Promise<Staff | null> {
  const who = normalise(email);
  if (!who) return null;
  let role: Role | null = null;
  if (who === normalise(firstAdmin)) {
    role = 'admin';
  } else {
    const row = await db.prepare('SELECT role FROM staff WHERE lower(email) = ?').bind(who).first<{ role: string }>();
    if (row?.role === 'admin' || row?.role === 'rep') role = row.role;
  }
  if (!role) return null;
  if (role === 'admin') {
    const { results } = await db.prepare('SELECT id FROM products ORDER BY id').all<{ id: string }>();
    return { email: who, role, products: results.map((r) => r.id) };
  }
  const { results } = await db
    .prepare('SELECT product_id FROM staff_products WHERE lower(email) = ? ORDER BY product_id')
    .bind(who)
    .all<{ product_id: string }>();
  return { email: who, role, products: results.map((r) => r.product_id) };
}

/**
 * The products a request may touch: all of the person's products, or the one
 * asked for if it is among them, else none. Always a new array.
 */
export function scope(staff: Staff, requested?: string): string[] {
  if (requested === undefined) return [...staff.products];
  return staff.products.includes(requested) ? [requested] : [];
}

/**
 * Hono middleware for desk and admin routes: 401 without a verified Access
 * token, 403 for someone Access let in who is not staff, else sets
 * `c.var.staff`. `jwks` stands in Access's keys in tests.
 */
export function requireStaff(jwks?: JWTVerifyGetKey): MiddlewareHandler<{ Bindings: StaffEnv; Variables: { staff: Staff } }> {
  return async (c, next) => {
    let email: string;
    try {
      ({ email } = await verifyAccess(c.req.raw, c.env, jwks));
    } catch {
      // verifyAccess wraps every failure, its key fetch included, in AuthError.
      return c.json({ error: 'unauthorised' }, 401);
    }
    // A deploy without its first admin cannot decide who is staff: said by name, never a 500 (shyden-labs/shydesk#81).
    const firstAdmin = c.env.FIRST_ADMIN_EMAIL as string | undefined;
    if (firstAdmin === undefined || firstAdmin.trim() === '') {
      console.error('FIRST_ADMIN_EMAIL is not set: no staff route can decide who is staff');
      return c.json({ error: 'FIRST_ADMIN_EMAIL is not set on this deploy' }, 503);
    }
    const staff = await loadStaff(c.env.DB, email, c.env.FIRST_ADMIN_EMAIL);
    if (!staff) return c.json({ error: 'forbidden' }, 403);
    c.set('staff', staff);
    return next();
  };
}
