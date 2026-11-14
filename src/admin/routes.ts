import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import type { D1Database } from '@cloudflare/workers-types';
import type { JWTVerifyGetKey } from 'jose';
import { requireStaff, type Staff, type StaffEnv } from '../auth/staff.ts';
import {
  SettingsError,
  createApiKey,
  getProduct,
  getTicketType,
  listApiKeys,
  listCanned,
  listProducts,
  listStaff,
  revokeApiKey,
  saveCanned,
  saveProduct,
  saveStaff,
  saveTicketType,
  type Product,
  type ProductInput,
  type SupportField,
} from '../products.ts';
import { productPage, productsPage, staffPage, type Health, type ProductForm, type ProductPageData } from './views.ts';
import { overdue } from '../desk/overdue.ts';
import { storageWarning, storedBytes } from '../storage.ts';

/**
 * The admin settings screen under /admin (shyden-labs/shydesk#17; plan
 * Task 4). Signed-in staff only (Access), admins only: a rep gets 404 on every
 * route, so the screen's existence does not leak. Form posts must come from
 * this origin (`csrf`). Each write goes through the settings store, which
 * validates it; a refused form comes back with its errors and what was typed.
 */

type AdminEnv = { Bindings: StaffEnv; Variables: { staff: Staff } };
/** A parsed form body; anything not a string (a file, a nested value) is ignored. */
type Form = Record<string, unknown>;

const text = (form: Form, key: string): string => {
  const value = form[key];
  return typeof value === 'string' ? value : '';
};

const texts = (form: Form, key: string): string[] => [form[key]].flat().filter((v): v is string => typeof v === 'string');

/** A number field: blank is not a number, so it fails validation rather than becoming 0. */
const num = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s));

/** Storage and missed timers, worked out now: no job keeps them (shyden-labs/shydesk#22). */
const health = async (db: D1Database): Promise<Health> => ({
  warning: storageWarning(await storedBytes(db)),
  overdue: await overdue(db, Date.now()),
});

const productForm = (form: Form): ProductForm => ({
  id: text(form, 'id'),
  name: text(form, 'name'),
  senderAddress: text(form, 'senderAddress'),
  ticketPageUrl: text(form, 'ticketPageUrl'),
  allowedOrigins: text(form, 'allowedOrigins'),
  monthlyEmailShare: text(form, 'monthlyEmailShare'),
  attachmentsKeepDays: text(form, 'attachmentsKeepDays'),
  textKeepDays: text(form, 'textKeepDays'),
  privacyPolicyUrlEn: text(form, 'privacyPolicyUrlEn'),
  privacyPolicyUrlId: text(form, 'privacyPolicyUrlId'),
});

const productInput = (f: ProductForm): ProductInput => ({
  id: f.id.trim(),
  name: f.name,
  senderAddress: f.senderAddress.trim(),
  ticketPageUrl: f.ticketPageUrl.trim(),
  allowedOrigins: f.allowedOrigins
    .split('\n')
    .map((o) => o.trim())
    .filter((o) => o !== ''),
  monthlyEmailShare: num(f.monthlyEmailShare),
  attachmentsKeepDays: num(f.attachmentsKeepDays),
  textKeepDays: num(f.textKeepDays),
  privacyPolicyUrlEn: f.privacyPolicyUrlEn.trim(),
  privacyPolicyUrlId: f.privacyPolicyUrlId.trim(),
});

const FIELD_LINE = 'write label; text or select; required or optional; then options for a choice list.';

/** Reads the support fields textarea: one field per line. Throws SettingsError naming each bad line. */
export function parseFields(textarea: string): SupportField[] {
  const errors: string[] = [];
  const fields: SupportField[] = [];
  textarea.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const [label = '', kind = '', need = '', options] = line.split(';').map((p) => p.trim());
    if (need !== 'required' && need !== 'optional') {
      errors.push(`Line ${i + 1}: ${FIELD_LINE}`);
      return;
    }
    const field: SupportField = { label, kind: kind as SupportField['kind'], required: need === 'required' };
    const list = (options ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== '');
    if (list.length > 0) field.options = list;
    fields.push(field);
  });
  if (errors.length > 0) throw new SettingsError(errors);
  return fields;
}

/** Runs a write; a refused one answers `refused(errors)` with 400 instead. */
async function attempt(write: () => Promise<Response>, refused: (errors: string[]) => Promise<Response>) {
  try {
    return await write();
  } catch (error) {
    if (error instanceof SettingsError) return refused(error.errors);
    throw error;
  }
}

export function adminRoutes(jwks?: JWTVerifyGetKey): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.use('/admin/*', requireStaff(jwks), async (c, next) => {
    // 404, not 403: a rep must not learn that the screen exists.
    if (c.var.staff.role !== 'admin') return c.notFound();
    return next();
  });
  app.use('/admin/*', csrf());

  /** The product named in the path, or a 404 response. */
  const productOr404 = async (c: Context<AdminEnv>, id: string): Promise<Product | Response> =>
    (await getProduct(c.env.DB, id)) ?? c.notFound();

  const productPageData = async (c: Context<AdminEnv>, product: Product): Promise<ProductPageData> => ({
    product,
    type: await getTicketType(c.env.DB, product.id),
    canned: await listCanned(c.env.DB, product.id),
    keys: await listApiKeys(c.env.DB, product.id),
  });

  const renderProduct = async (c: Context<AdminEnv>, product: Product, extra: Partial<ProductPageData>, status: 200 | 400) =>
    c.html(productPage({ ...(await productPageData(c, product)), ...extra }), status);

  app.get('/admin', async (c) => c.html(productsPage(await listProducts(c.env.DB), await health(c.env.DB))));

  app.post('/admin/products', async (c) => {
    const form = productForm(await c.req.parseBody());
    return attempt(
      async () => {
        await saveProduct(c.env.DB, productInput(form));
        return c.redirect(`/admin/products/${form.id.trim()}`, 303);
      },
      async (errors) => c.html(productsPage(await listProducts(c.env.DB), await health(c.env.DB), form, errors), 400),
    );
  });

  app.get('/admin/products/:id', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    return renderProduct(c, product, {}, 200);
  });

  app.post('/admin/products/:id', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    // The id comes from the path: a product's id never changes once made.
    const form = { ...productForm(await c.req.parseBody()), id: product.id };
    return attempt(
      async () => {
        await saveProduct(c.env.DB, productInput(form));
        return c.redirect(`/admin/products/${product.id}`, 303);
      },
      (errors) => renderProduct(c, product, { form, errors: { product: errors } }, 400),
    );
  });

  app.post('/admin/products/:id/support', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    const body = await c.req.parseBody();
    const supportForm = { name: text(body, 'name'), fields: text(body, 'fields') };
    return attempt(
      async () => {
        await saveTicketType(c.env.DB, { productId: product.id, name: supportForm.name, fields: parseFields(supportForm.fields) });
        return c.redirect(`/admin/products/${product.id}`, 303);
      },
      (errors) => renderProduct(c, product, { supportForm, errors: { support: errors } }, 400),
    );
  });

  app.post('/admin/products/:id/canned', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    const body = await c.req.parseBody();
    const typeId = text(body, 'typeId');
    return attempt(
      async () => {
        await saveCanned(c.env.DB, {
          productId: product.id,
          typeId: typeId === '' ? null : typeId,
          name: text(body, 'name'),
          body: text(body, 'body'),
        });
        return c.redirect(`/admin/products/${product.id}`, 303);
      },
      (errors) => renderProduct(c, product, { errors: { canned: errors } }, 400),
    );
  });

  app.post('/admin/products/:id/api-keys', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    const label = text(await c.req.parseBody(), 'label');
    return attempt(
      async () => {
        const newKey = await createApiKey(c.env.DB, product.id, label);
        // Shown on this response only: never redirected to, never stored.
        return renderProduct(c, product, { newKey }, 200);
      },
      (errors) => renderProduct(c, product, { errors: { keys: errors } }, 400),
    );
  });

  app.post('/admin/products/:id/api-keys/:hash/revoke', async (c) => {
    const product = await productOr404(c, c.req.param('id'));
    if (product instanceof Response) return product;
    await revokeApiKey(c.env.DB, product.id, c.req.param('hash'));
    return c.redirect(`/admin/products/${product.id}`, 303);
  });

  app.get('/admin/staff', async (c) => c.html(staffPage(await listStaff(c.env.DB), await listProducts(c.env.DB))));

  app.post('/admin/staff', async (c) => {
    const body = await c.req.parseBody({ all: true });
    return attempt(
      async () => {
        const role = text(body, 'role') as 'admin' | 'rep';
        await saveStaff(c.env.DB, { email: text(body, 'email'), role, products: texts(body, 'products') });
        return c.redirect('/admin/staff', 303);
      },
      async (errors) => c.html(staffPage(await listStaff(c.env.DB), await listProducts(c.env.DB), errors), 400),
    );
  });

  return app;
}
