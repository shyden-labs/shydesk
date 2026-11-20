// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// The shared support piece (shyden-labs/shydesk#19, shyden-labs/shydesk#20, shyden-labs/shydesk#21, shyden-labs/shydesk#24,
// shyden-labs/shydesk#25, shyden-labs/shydesk#61): the
// contact form, the private link's conversation and the appeal view, as a page
// that loads public/embed.js from ShyDesk sees them. The script registers its
// element once per page, so this file loads it once; Turnstile and the two
// modules the piece loads from ShyDesk are stood in where they would be. The
// real browsers are the e2e suite's.
const HOST = 'https://shydesk.test';

const stand = vi.hoisted(() => ({
  media: {
    videoSeconds: vi.fn<(file: Blob) => Promise<number | null>>(),
    shrinkVideo: vi.fn<(file: Blob) => Promise<Blob | null>>(),
    shrinkImage: vi.fn<(file: Blob) => Promise<Blob | null>>(),
    thumbnailOf: vi.fn<(file: Blob, kind: string) => Promise<Blob | null>>(),
    uploadAttachment:
      vi.fn<
        (upload: { file: Blob; kind: string; mime: string; onProgress: (done: number) => void }) => Promise<{ id: string; bytes: number }>
      >(),
  },
  openViewer: vi.fn(),
  turnstile: { render: vi.fn(), reset: vi.fn() },
}));

vi.mock('https://shydesk.test/embed-media.js', async () => ({
  ...(await vi.importActual<typeof import('../../public/embed-media.js')>('../../public/embed-media.js')),
  ...stand.media,
}));
vi.mock('https://shydesk.test/embed-viewer.js', () => ({ openViewer: stand.openViewer }));

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Route> = {};
let asked: { method: string; path: string; product: string | null; init: RequestInit | undefined }[] = [];
const scripts: HTMLScriptElement[] = [];
let objectUrls = 0;
let revoke: MockInstance<typeof URL.revokeObjectURL>;

const config = {
  product: { id: 'demo', name: 'Demo' },
  types: [
    {
      id: 'support',
      name: 'Support',
      fields: [
        { label: 'Order', kind: 'text', required: true },
        { label: 'Platform', kind: 'select', required: false, options: ['iOS', 'Android'] },
        { label: 'Mood', kind: 'select', required: false },
      ],
    },
  ],
  categories: ['question', 'bug', 'mystery'],
  maxAttachments: 2,
  maxVideoSeconds: 30,
  turnstileSiteKey: 'site-key',
};

const thread = {
  ticket: { subject: 'Cannot sign in', status: 'open', createdAt: 1 },
  messages: [
    {
      author: 'customer',
      body: 'Help\nplease',
      createdAt: 1,
      attachments: [
        { id: 'p 1', mime: 'image/jpeg', bytes: 1500, durationMs: null, removed: false },
        { id: 'old', mime: 'image/jpeg', bytes: 10, durationMs: null, removed: true },
      ],
    },
    {
      author: 'staff',
      body: 'Looking now',
      createdAt: 2,
      attachments: [{ id: 'v1', mime: 'video/mp4', bytes: 2001, durationMs: 5000, removed: false }],
    },
  ],
};

beforeAll(async () => {
  // Turnstile's script is never fetched: the piece's tag is kept and told it loaded, with the API in place.
  Object.assign(globalThis, { turnstile: stand.turnstile });
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) {
        scripts.push(node);
        queueMicrotask(() => node.dispatchEvent(new Event('load')));
      } else {
        append(node);
      }
    }
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${String(++objectUrls)}`);
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  Object.defineProperty(document, 'currentScript', { configurable: true, value: { src: `${HOST}/embed.js` } });
  await import('../../public/embed.js');
});

beforeEach(() => {
  routes = {};
  asked = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const at = new URL(url);
    const path = at.pathname.replace('/support-api/', '');
    const method = init?.method ?? 'GET';
    asked.push({ method, path, product: at.searchParams.get('product'), init });
    const route = routes[`${method} ${path}`];
    if (at.origin !== HOST || route === undefined) return Promise.reject(new TypeError(`refused ${method} ${url}`));
    return Promise.resolve(route(init));
  });
  stand.turnstile.render.mockReset().mockReturnValue('widget-1');
  stand.turnstile.reset.mockReset();
  stand.openViewer.mockReset();
  stand.media.videoSeconds.mockReset().mockResolvedValue(10);
  stand.media.shrinkVideo.mockReset().mockResolvedValue(null);
  stand.media.shrinkImage.mockReset().mockResolvedValue(new Blob(['s']));
  stand.media.thumbnailOf.mockReset().mockResolvedValue(new Blob(['t']));
  let uploaded = 0;
  stand.media.uploadAttachment.mockReset().mockImplementation(() => Promise.resolve({ id: `file-${String(++uploaded)}`, bytes: 2500 }));
  revoke.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  location.hash = '';
});

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The piece placed on the page with `attributes`, once its status line says `until`. */
async function mount(attributes: Record<string, string>, until: string) {
  const piece = document.createElement('shydesk-support');
  for (const [name, value] of Object.entries(attributes)) piece.setAttribute(name, value);
  document.body.append(piece);
  const root = piece.shadowRoot;
  if (root === null) throw new Error('the piece drew no shadow root');
  const status = () => root.querySelector('p[role="status"]')?.textContent;
  await vi.waitFor(() => {
    expect(status()).toBe(until);
  });
  return { piece, root, status };
}

/** Each labelled control of a form, by its label. */
function controls(root: ParentNode) {
  const found: Record<string, HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement> = {};
  for (const label of root.querySelectorAll('label')) {
    const control = label.querySelector('input, select, textarea');
    if (control !== null) found[label.firstChild?.textContent ?? ''] = control as never;
  }
  return found;
}

const submit = (form: Element | null) => {
  form?.dispatchEvent(new Event('submit', { cancelable: true }));
};

/** What the last POST to `path` sent. */
function sent(path: string): unknown {
  const call = asked.filter((one) => one.method === 'POST' && one.path === path).at(-1);
  const body = call?.init?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

describe('the script', () => {
  it('registers the piece once, so a second copy on the page changes nothing', async () => {
    expect(customElements.get('shydesk-support')).toBeDefined();
    vi.resetModules();
    await expect(import('../../public/embed.js')).resolves.toBeDefined();
  });

  it('watches the product, view and lang attributes', () => {
    const piece = customElements.get('shydesk-support') as unknown as { observedAttributes: string[] };
    expect(piece.observedAttributes).toEqual(['product', 'view', 'lang']);
  });
});

describe('the contact form', () => {
  async function contact(product = 'demo app') {
    routes['GET config'] = () => json(config);
    const rendered = stand.turnstile.render.mock.calls.length;
    const view = await mount({ product, view: 'contact' }, 'Complete the check below to send.');
    await vi.waitFor(() => {
      expect(stand.turnstile.render).toHaveBeenCalledTimes(rendered + 1);
    });
    const form = view.root.querySelector('form');
    const send = view.root.querySelector<HTMLButtonElement>('button[type="submit"]');
    const options = stand.turnstile.render.mock.calls.at(-1)?.[1] as {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
    };
    const picker = view.piece.querySelector<HTMLInputElement>('input[type="file"]');
    const lines = view.root.querySelector('.attachments');
    return { ...view, form, send, options, picker, lines, fields: controls(view.root) };
  }

  it('asks for the product config on the host the script came from, once however often it is placed', async () => {
    const { piece } = await contact();
    piece.remove();
    document.body.append(piece);
    expect(asked.filter((one) => one.path === 'config')).toEqual([{ method: 'GET', path: 'config', product: 'demo app', init: undefined }]);
  });

  it('asks for the config, and sends files, for no product when the page names none', async () => {
    routes['GET config'] = () => json(config);
    const { piece, root } = await mount({}, 'Complete the check below to send.');
    expect(asked[0]?.product).toBe('');
    const picker = piece.querySelector<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(picker, 'files', { value: [new File(['p'], 'a.jpg', { type: 'image/jpeg' })] });
    picker?.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(root.querySelector('.attachments')?.textContent).toBe('a.jpg: attached, 3 KB');
    });
    expect(stand.media.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({ product: '' });
  });

  it('draws every field labelled, each error line named by its control, and the product type extras', async () => {
    const { root, fields } = await contact();
    expect(Object.keys(fields)).toEqual(['Email', 'Subject', 'Category', 'Message', 'Order', 'Platform', 'Mood']);
    expect(fields.Email?.getAttribute('type')).toBe('email');
    expect(fields.Email?.hasAttribute('required')).toBe(true);
    expect(fields.Subject?.getAttribute('maxlength')).toBe('150');
    expect(fields.Message?.getAttribute('maxlength')).toBe('10000');
    expect([...(fields.Category?.options ?? [])].map((one) => [one.value, one.textContent])).toEqual([
      ['question', 'Question'],
      ['bug', 'Something is not working'],
      ['mystery', 'mystery'],
    ]);
    expect(fields.Order?.hasAttribute('required')).toBe(true);
    expect(fields.Order?.getAttribute('maxlength')).toBe('1000');
    expect([...(fields.Platform?.options ?? [])].map((one) => one.value)).toEqual(['', 'iOS', 'Android']);
    expect(fields.Platform?.hasAttribute('required')).toBe(false);
    expect([...(fields.Mood?.options ?? [])].map((one) => one.textContent)).toEqual(['Choose…']);
    for (const control of Object.values(fields)) {
      const error = root.getElementById(control.getAttribute('aria-describedby') ?? '');
      expect(error?.className).toBe('error');
    }
    expect(root.querySelector('style')?.textContent).toContain('--shydesk-accent');
  });

  it('puts the file picker and the Turnstile widget in the page, shown through slots', async () => {
    const { piece, root, picker, options } = await contact();
    expect(picker?.getAttribute('slot')).toBe('picker');
    expect(picker?.getAttribute('accept')).toBe('image/*,video/*');
    expect(picker?.hasAttribute('multiple')).toBe(true);
    expect(picker?.getAttribute('aria-label')).toBe('Photos and videos');
    const holder = piece.querySelector('[slot="turnstile"]');
    expect(holder).not.toBeNull();
    expect(root.querySelector('slot[name="picker"]')).not.toBeNull();
    expect(root.querySelector('slot[name="turnstile"]')).not.toBeNull();
    expect(stand.turnstile.render.mock.calls[0]?.[0]).toBe(holder);
    expect(options.sitekey).toBe('site-key');
  });

  it("loads Turnstile's script once, however many forms the page has", async () => {
    await contact();
    await contact();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(scripts[0]?.async).toBe(true);
  });

  it('can be sent only once the check has passed, and not once its token expires', async () => {
    const { send, options, status } = await contact();
    expect(send?.disabled).toBe(true);
    options.callback('token-1');
    expect(send?.disabled).toBe(false);
    expect(status()).toBe('Ready to send');
    options['expired-callback']();
    expect(send?.disabled).toBe(true);
    expect(status()).toBe('Complete the check below to send.');
  });

  it('says it cannot load when the config is refused', async () => {
    routes['GET config'] = () => json({}, 403);
    await mount({ product: 'demo' }, 'The support form could not load here.');
  });

  it('says it cannot load when the config cannot be fetched', async () => {
    await mount({ product: 'demo' }, 'The support form could not load here.');
  });

  it('says it cannot load when the product has no support type', async () => {
    routes['GET config'] = () => json({ ...config, types: [] });
    const { root } = await mount({ product: 'demo' }, 'The support form could not load here.');
    expect(root.querySelector('form')).toBeNull();
  });

  it('sends every field, the files and the check token, then shows the private link and that it was mailed', async () => {
    const view = await contact();
    view.options.callback('token-1');
    Object.assign(view.fields.Email ?? {}, { value: 'a@example.com' });
    Object.assign(view.fields.Subject ?? {}, { value: 'Locked out' });
    Object.assign(view.fields.Category ?? {}, { value: 'bug' });
    Object.assign(view.fields.Message ?? {}, { value: 'It says no' });
    Object.assign(view.fields.Order ?? {}, { value: 'A-1' });
    Object.assign(view.fields.Platform ?? {}, { value: 'iOS' });
    routes['POST tickets'] = () => json({ ticketLink: `${HOST}/t#t=abc`, emailSent: true }, 201);
    submit(view.form);
    expect(view.send?.disabled).toBe(true);
    expect(view.status()).toBe('Sending…');
    await vi.waitFor(() => {
      expect(view.status()).toBe('The same link is on its way by email.');
    });
    const call = asked.find((one) => one.path === 'tickets');
    expect(call?.product).toBe('demo app');
    expect(call?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sent('tickets')).toEqual({
      email: 'a@example.com',
      subject: 'Locked out',
      category: 'bug',
      message: 'It says no',
      fields: { Order: 'A-1', Platform: 'iOS', Mood: '' },
      attachmentIds: [],
      turnstileToken: 'token-1',
    });
    expect(view.form?.hidden).toBe(true);
    expect(view.picker?.isConnected).toBe(false);
    expect(view.piece.querySelector('[slot="turnstile"]')).toBeNull();
    const link = view.root.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`${HOST}/t#t=abc`);
    expect(link?.textContent).toBe(`${HOST}/t#t=abc`);
    expect(link?.getAttribute('aria-label')).toBe('Private link');
    expect(link?.previousElementSibling?.textContent).toBe('Request sent. Keep this private link to follow it:');
  });

  it('says to keep the link when the email could not be sent', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({ ticketLink: `${HOST}/t#t=abc`, emailSent: false }, 201);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The email could not be sent. Keep this link to follow the request.');
    });
  });

  it('marks each refused field, asks for a new check and keeps the form', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () =>
      json({ errors: { email: 'Enter an email.', 'fields.Order': 'Needed.', turnstileToken: 'Try again.', nope: 'x' } }, 400);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Check the fields marked below.');
    });
    const errorOf = (name: string) => view.root.getElementById(view.fields[name]?.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(errorOf('Email')).toBe('Enter an email.');
    expect(errorOf('Order')).toBe('Needed.');
    expect(errorOf('Subject')).toBe('');
    expect([...view.root.querySelectorAll('.error')].map((one) => one.textContent)).toContain('Try again.');
    await vi.waitFor(() => {
      expect(stand.turnstile.reset).toHaveBeenCalledWith('widget-1');
    });
    expect(view.form?.hidden).toBe(false);
    routes['POST tickets'] = () => json({ error: 'Too many requests.' }, 429);
    view.options.callback('token-2');
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Too many requests.');
    });
    expect(errorOf('Email')).toBe('');
    expect(sent('tickets')).toMatchObject({ turnstileToken: 'token-2' });
  });

  // shyden-labs/shydesk#242: Turnstile's new token after a refusal must not hide why the request was refused.
  it('keeps saying why a request was refused when the check hands over a new token, until the form changes', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({ error: 'Too many requests for now. Try again in an hour.' }, 429);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Too many requests for now. Try again in an hour.');
    });
    view.options.callback('token-2');
    expect(view.status()).toBe('Too many requests for now. Try again in an hour.');
    expect(view.send?.disabled).toBe(false);
    view.fields.Subject?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.status()).toBe('Ready to send');
  });

  it('asks for the check again when the form changes after a refusal before a new token comes', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({ error: 'No.' }, 400);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('No.');
    });
    view.fields.Subject?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.status()).toBe('Complete the check below to send.');
    view.fields.Subject?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.status()).toBe('Complete the check below to send.');
  });

  it('keeps the field errors summary when the check hands over a new token', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({ errors: { email: 'Enter an email.' } }, 400);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Check the fields marked below.');
    });
    view.options.callback('token-2');
    expect(view.status()).toBe('Check the fields marked below.');
  });

  it('says it was not sent when the answer says nothing it can read', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => new Response('<html>', { status: 502 });
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The request could not be sent. Try again.');
    });
  });

  it('treats a created answer with no link as not sent', async () => {
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({}, 201);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The request could not be sent. Try again.');
    });
    expect(view.form?.hidden).toBe(false);
  });

  it('asks Turnstile for no reset when it gave no widget', async () => {
    stand.turnstile.render.mockReturnValue(undefined);
    const view = await contact();
    view.options.callback('token-1');
    routes['POST tickets'] = () => json({ error: 'No.' }, 400);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('No.');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stand.turnstile.reset).not.toHaveBeenCalled();
  });

  it('lets the customer try again when the request cannot be sent at all', async () => {
    const view = await contact();
    view.options.callback('token-1');
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The request could not be sent. Try again.');
    });
    expect(view.send?.disabled).toBe(false);
  });

  describe('attachments', () => {
    const pick = (picker: HTMLInputElement | null, files: File[] | null) => {
      if (picker === null) throw new Error('no picker');
      Object.defineProperty(picker, 'files', { configurable: true, value: files });
      picker.dispatchEvent(new Event('change'));
    };

    it('shrinks a photo, sends the smaller as a JPEG with its preview, says how far it got, and sends its id', async () => {
      const view = await contact();
      view.options.callback('token-1');
      let finish: (value: { id: string; bytes: number }) => void = () => undefined;
      let progress: (done: number) => void = () => undefined;
      stand.media.uploadAttachment.mockImplementationOnce((upload: { onProgress: (done: number) => void }) => {
        progress = upload.onProgress;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const shrunk = new Blob(['s'], { type: 'image/jpeg' });
      stand.media.shrinkImage.mockResolvedValueOnce(shrunk);
      const preview = new Blob(['preview']);
      stand.media.thumbnailOf.mockResolvedValueOnce(preview);
      const photo = new File(['a big photo'], 'cat.webp', { type: 'image/webp' });
      pick(view.picker, [photo]);
      expect(view.lines?.textContent).toBe('cat.webp: uploading…');
      expect(view.send?.disabled).toBe(true);
      await vi.waitFor(() => {
        expect(stand.media.uploadAttachment).toHaveBeenCalledOnce();
      });
      expect(stand.media.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({
        host: HOST,
        product: 'demo app',
        file: shrunk,
        kind: 'image',
        mime: 'image/jpeg',
        thumbnail: preview,
      });
      expect(stand.media.thumbnailOf).toHaveBeenCalledWith(photo, 'image');
      progress(0.5);
      expect(view.lines?.textContent).toBe('cat.webp: uploading… 50 %');
      finish({ id: 'file-9', bytes: 2500 });
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('cat.webp: attached, 3 KB');
      });
      expect(view.send?.disabled).toBe(false);
      routes['POST tickets'] = () => json({ error: 'No.' }, 400);
      submit(view.form);
      await vi.waitFor(() => {
        expect(view.status()).toBe('No.');
      });
      expect(sent('tickets')).toMatchObject({ attachmentIds: ['file-9'] });
    });

    it('sends a photo as it is, with its own type, when shrinking makes it no smaller', async () => {
      const view = await contact();
      stand.media.shrinkImage.mockResolvedValueOnce(new Blob(['a much bigger copy']));
      const photo = new File(['tiny'], 'cat.jpg', { type: 'image/jpeg' });
      pick(view.picker, [photo]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('cat.jpg: attached, 3 KB');
      });
      expect(stand.media.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({ file: photo, mime: 'image/jpeg' });
    });

    it('converts a photo the server does not keep, and refuses it when this browser cannot', async () => {
      const view = await contact();
      const converted = new Blob(['a converted copy that is bigger']);
      stand.media.shrinkImage.mockResolvedValueOnce(converted).mockResolvedValueOnce(null);
      pick(view.picker, [new File(['png'], 'one.png', { type: 'image/png' }), new File(['heic'], 'two.heic', { type: 'image/heic' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('one.png: attached, 3 KB\ntwo.heic: Only photos and MP4 videos can be attached.');
      });
      expect(stand.media.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({ file: converted, mime: 'image/jpeg' });
    });

    it('keeps sending off after an upload until the check has passed', async () => {
      const view = await contact();
      pick(view.picker, [new File(['p'], 'a.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('a.jpg: attached, 3 KB');
      });
      expect(view.send?.disabled).toBe(true);
    });

    it('keeps sending off after a refused send, even once an upload finishes, until a new check passes', async () => {
      const view = await contact();
      view.options.callback('token-1');
      routes['POST tickets'] = () => json({ error: 'No.' }, 400);
      submit(view.form);
      await vi.waitFor(() => {
        expect(view.status()).toBe('No.');
      });
      pick(view.picker, [new File(['p'], 'a.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('a.jpg: attached, 3 KB');
      });
      expect(view.send?.disabled).toBe(true);
      view.options.callback('token-2');
      expect(view.send?.disabled).toBe(false);
    });

    it('clears the picker once every picked file is done with, so the same file can be picked again', async () => {
      const view = await contact();
      const cleared = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
      let finish: (value: { id: string; bytes: number }) => void = () => undefined;
      stand.media.uploadAttachment.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      pick(view.picker, [new File(['p'], 'a.jpg', { type: 'image/jpeg' }), new File(['p'], 'b.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => {
        expect(stand.media.uploadAttachment).toHaveBeenCalledOnce();
      });
      expect(cleared.mock.contexts).not.toContain(view.picker);
      finish({ id: 'file-1', bytes: 1 });
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('a.jpg: attached, 1 KB\nb.jpg: attached, 3 KB');
      });
      expect(cleared.mock.contexts.filter((one) => one === view.picker)).toHaveLength(1);
      expect(cleared.mock.calls.at(-1)).toEqual(['']);
      cleared.mockRestore();
    });

    it('refuses a file that is neither a photo nor an MP4 video', async () => {
      const view = await contact();
      pick(view.picker, [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('notes.txt: Only photos and MP4 videos can be attached.');
      });
      expect(stand.media.uploadAttachment).not.toHaveBeenCalled();
    });

    it('sends a video of up to 30 s, shrunk when that is smaller, and one whose length cannot be read', async () => {
      const view = await contact();
      const shrunk = new Blob(['s']);
      stand.media.videoSeconds.mockResolvedValueOnce(30).mockResolvedValueOnce(null);
      stand.media.shrinkVideo.mockResolvedValueOnce(shrunk);
      const first = new File(['a long video'], 'one.mov', { type: 'video/quicktime' });
      const second = new File(['another video'], 'two.mp4', { type: 'video/mp4' });
      pick(view.picker, [first, second]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('one.mov: attached, 3 KB\ntwo.mp4: attached, 3 KB');
      });
      expect(stand.media.uploadAttachment.mock.calls.map(([upload]) => [upload.file, upload.kind, upload.mime])).toEqual([
        [shrunk, 'video', 'video/mp4'],
        [second, 'video', 'video/mp4'],
      ]);
      expect(stand.media.thumbnailOf).toHaveBeenCalledWith(first, 'video');
    });

    it('refuses a video over 30 s', async () => {
      const view = await contact();
      stand.media.videoSeconds.mockResolvedValueOnce(30.5);
      pick(view.picker, [new File(['v'], 'long.mp4', { type: 'video/mp4' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('long.mp4: Videos can be up to 30 seconds long.');
      });
      expect(stand.media.shrinkVideo).not.toHaveBeenCalled();
    });

    it('refuses files past the most the product allows', async () => {
      const view = await contact();
      const photo = (name: string) => new File(['p'], name, { type: 'image/jpeg' });
      pick(view.picker, [photo('1.jpg'), photo('2.jpg'), photo('3.jpg')]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('1.jpg: attached, 3 KB\n2.jpg: attached, 3 KB\n3.jpg: Attach up to 10 files.');
      });
      expect(stand.media.uploadAttachment).toHaveBeenCalledTimes(2);
    });

    it('says why an upload failed, or that it failed when there is no reason', async () => {
      const view = await contact();
      stand.media.uploadAttachment.mockRejectedValueOnce(new Error('The storage is full.')).mockRejectedValueOnce('no reason');
      pick(view.picker, [new File(['p'], 'a.jpg', { type: 'image/jpeg' }), new File(['p'], 'b.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => {
        expect(view.lines?.textContent).toBe('a.jpg: The storage is full.\nb.jpg: The file could not be uploaded. Try again.');
      });
    });

    it('does nothing when the picker reports no files', async () => {
      const view = await contact();
      pick(view.picker, null);
      expect(view.lines?.textContent).toBe('');
      expect(view.send?.disabled).toBe(true);
    });
  });
});

describe('the private link', () => {
  async function ticket(hash = '#t=secret') {
    location.hash = hash;
    routes['GET ticket'] = () => json(thread);
    routes['GET config'] = () => json(config);
    routes['GET files/p%201/thumb'] = () => new Response(new Blob(['thumb']));
    routes['GET files/v1/thumb'] = () => new Response('', { status: 404 });
    const view = await mount({ product: 'demo', view: 'ticket' }, '');
    const log = view.root.querySelector('[role="log"]');
    const form = view.root.querySelector('form');
    const box = view.root.querySelector<HTMLTextAreaElement>('textarea');
    const send = view.root.querySelector<HTMLButtonElement>('button[type="submit"]');
    return { ...view, log, form, box, send };
  }

  it('shows the conversation, read with the token from the fragment in a header', async () => {
    const { log } = await ticket();
    expect(log?.getAttribute('aria-label')).toBe('Conversation');
    expect(log?.querySelector('h2')?.textContent).toBe('Cannot sign in');
    const articles = [...(log?.querySelectorAll('article') ?? [])];
    expect(articles.map((one) => one.querySelector('strong')?.textContent)).toEqual(['You', 'Support']);
    expect(articles.map((one) => one.querySelector('p')?.textContent)).toEqual(['Help\nplease', 'Looking now']);
    expect(articles[0]?.querySelector('p')?.getAttribute('style')).toBe('white-space: pre-wrap');
    const call = asked.find((one) => one.path === 'ticket');
    expect(call?.init?.headers).toEqual({ Authorization: 'Ticket secret' });
    expect(call?.product).toBe('demo');
  });

  it('numbers the previews of stored files, and says which were removed', async () => {
    const { log } = await ticket();
    const buttons = [...(log?.querySelectorAll('button.preview') ?? [])];
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['Open photo 1', 'Open video 2']);
    expect(buttons.every((one) => one.getAttribute('type') === 'button')).toBe(true);
    const lines = [...(log?.querySelectorAll('article > p:not([style])') ?? [])].map((one) => one.textContent);
    expect(lines).toEqual(['Attachment, 2 KB', 'Attachment removed after 30 days.', 'Video, 3 KB']);
  });

  it('shows each preview fetched with the token, and drops one that cannot be fetched', async () => {
    const { log } = await ticket();
    await vi.waitFor(() => {
      expect(log?.querySelector('img[aria-label="Attachment preview 1"]')?.getAttribute('src')).toMatch(/^blob:/);
    });
    const image = log?.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('Attachment preview 1');
    expect(image?.getAttribute('width')).toBe('160');
    await vi.waitFor(() => {
      expect(log?.querySelector('img[aria-label="Attachment preview 2"]')).toBeNull();
    });
    expect(asked.find((one) => one.path === 'files/p%201/thumb')?.init?.headers).toEqual({ Authorization: 'Ticket secret' });
  });

  it('drops a preview whose fetch fails outright', async () => {
    location.hash = '#t=secret';
    routes['GET ticket'] = () => json(thread);
    routes['GET config'] = () => json(config);
    const { root } = await mount({ product: 'demo', view: 'ticket' }, '');
    await vi.waitFor(() => {
      expect(root.querySelectorAll('img')).toHaveLength(0);
    });
  });

  it('sends an empty token when the link has none', async () => {
    await ticket('');
    expect(asked.find((one) => one.path === 'ticket')?.init?.headers).toEqual({ Authorization: 'Ticket ' });
  });

  it('says the link is no longer valid when ShyDesk does not know it', async () => {
    location.hash = '#t=old';
    routes['GET ticket'] = () => json({}, 404);
    const { root } = await mount({ product: 'demo', view: 'ticket' }, 'This link is no longer valid.');
    expect(root.querySelector('form')).toBeNull();
  });

  it('says it cannot load when ShyDesk answers with an error', async () => {
    routes['GET ticket'] = () => json({}, 500);
    await mount({ product: 'demo', view: 'ticket' }, 'The support form could not load here.');
  });

  it('says it cannot load when the conversation cannot be fetched', async () => {
    await mount({ product: 'demo', view: 'ticket' }, 'The support form could not load here.');
  });

  it('says it cannot load when the config is refused, after the conversation', async () => {
    routes['GET ticket'] = () => json(thread);
    routes['GET config'] = () => json({}, 500);
    const { root } = await mount({ product: 'demo', view: 'ticket' }, 'The support form could not load here.');
    expect(root.querySelector('form')).toBeNull();
  });

  it('says it cannot load when the config cannot be fetched, after the conversation', async () => {
    routes['GET ticket'] = () => json(thread);
    await mount({ product: 'demo', view: 'ticket' }, 'The support form could not load here.');
  });

  it('has a labelled reply box, a picker in the page and a send button', async () => {
    const { piece, root, box, send } = await ticket();
    expect(box?.getAttribute('aria-label')).toBe('Reply');
    expect(box?.hasAttribute('required')).toBe(true);
    expect(send?.textContent).toBe('Send reply');
    expect(piece.querySelector('input[type="file"]')?.getAttribute('slot')).toBe('picker');
    expect(root.querySelector('slot[name="picker"]')).not.toBeNull();
  });

  it('sends a reply with its files, clears the box and shows the conversation again', async () => {
    const view = await ticket();
    const picker = view.piece.querySelector<HTMLInputElement>('input[type="file"]');
    if (picker === null) throw new Error('no picker');
    let finish: (value: { id: string; bytes: number }) => void = () => undefined;
    stand.media.uploadAttachment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: [new File(['p'], 'shot.jpg', { type: 'image/jpeg' })],
    });
    picker.dispatchEvent(new Event('change'));
    expect(view.send?.disabled).toBe(true);
    await vi.waitFor(() => {
      expect(stand.media.uploadAttachment).toHaveBeenCalledOnce();
    });
    finish({ id: 'file-7', bytes: 900 });
    await vi.waitFor(() => {
      expect(view.send?.disabled).toBe(false);
    });
    if (view.box !== null) view.box.value = 'Still broken';
    routes['POST ticket/reply'] = () => json({}, 201);
    routes['GET ticket'] = () => json({ ...thread, ticket: { ...thread.ticket, subject: 'Updated' } });
    submit(view.form);
    expect(view.send?.disabled).toBe(true);
    expect(view.status()).toBe('Sending…');
    await vi.waitFor(() => {
      expect(view.status()).toBe('Reply sent.');
    });
    expect(sent('ticket/reply')).toEqual({ message: 'Still broken', attachmentIds: ['file-7'] });
    expect(asked.find((one) => one.path === 'ticket/reply')?.init?.headers).toEqual({
      Authorization: 'Ticket secret',
      'Content-Type': 'application/json',
    });
    expect(view.box?.value).toBe('');
    expect(view.root.querySelector('.attachments')?.textContent).toBe('');
    expect(view.log?.querySelector('h2')?.textContent).toBe('Updated');
    expect(view.send?.disabled).toBe(false);
  });

  it('says why a reply was refused, and keeps what was written', async () => {
    const view = await ticket();
    if (view.box !== null) view.box.value = 'Hello';
    routes['POST ticket/reply'] = () => json({ error: 'This ticket is closed.' }, 409);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('This ticket is closed.');
    });
    expect(view.box?.value).toBe('Hello');
    expect(view.send?.disabled).toBe(false);
  });

  it('says the reply was not sent when the refusal names no reason', async () => {
    const view = await ticket();
    routes['POST ticket/reply'] = () => new Response('oops', { status: 500 });
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The reply could not be sent. Try again.');
    });
  });

  it('says the reply was not sent when it cannot be sent at all', async () => {
    const view = await ticket();
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The reply could not be sent. Try again.');
    });
  });

  describe('the viewer', () => {
    it('opens on the pressed preview, inside the piece, with every stored file in order', async () => {
      const { root, log } = await ticket();
      log?.querySelectorAll<HTMLButtonElement>('button.preview')[1]?.click();
      await vi.waitFor(() => {
        expect(stand.openViewer).toHaveBeenCalledOnce();
      });
      const options = stand.openViewer.mock.calls[0]?.[0] as {
        doc: unknown;
        host: unknown;
        start: number;
        items: { mime: string }[];
      };
      expect(options.doc).toBe(document);
      expect(options.host).toBe(root);
      expect(options.start).toBe(1);
      expect(options.items.map((one) => one.mime)).toEqual(['image/jpeg', 'video/mp4']);
    });

    it('fetches each file once with the token, and drops the page copies when it closes', async () => {
      const { log } = await ticket();
      routes['GET files/p%201'] = () => new Response(new Blob(['photo']));
      routes['GET files/v1'] = () => new Response('', { status: 404 });
      log?.querySelector<HTMLButtonElement>('button.preview')?.click();
      await vi.waitFor(() => {
        expect(stand.openViewer).toHaveBeenCalledOnce();
      });
      const options = stand.openViewer.mock.calls[0]?.[0] as {
        items: { load: () => Promise<string> }[];
        onClose: () => void;
      };
      const [photo, video] = options.items;
      const address = await photo?.load();
      expect(address).toMatch(/^blob:/);
      expect(await photo?.load()).toBe(address);
      expect(asked.filter((one) => one.path === 'files/p%201')).toHaveLength(1);
      expect(asked.find((one) => one.path === 'files/p%201')?.init?.headers).toEqual({ Authorization: 'Ticket secret' });
      await expect(video?.load()).rejects.toThrow('file v1: 404');
      options.onClose();
      await vi.waitFor(() => {
        expect(revoke).toHaveBeenCalledWith(address);
      });
      expect(revoke).toHaveBeenCalledOnce();
    });
  });
});

describe('the appeal view', () => {
  async function appeal(decision: unknown = { label: 'Banned from chat for 7 days', can_appeal: true }) {
    location.hash = '#appeal=notice-token';
    routes['GET appeals'] = () => json(decision);
    const view = await mount({ product: 'demo', view: 'appeal' }, '');
    const form = view.root.querySelector('form');
    const button = view.root.querySelector<HTMLButtonElement>('button[type="submit"]');
    return { ...view, form, button, fields: controls(view.root) };
  }

  it('shows the decision the notice names, read with its token in a header', async () => {
    const { root, fields, button } = await appeal();
    const section = root.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe('Decision');
    expect(section?.querySelector('h2')?.textContent).toBe('Appeal this decision');
    expect(section?.querySelector('p')?.textContent).toBe('Banned from chat for 7 days');
    expect(asked[0]?.init?.headers).toEqual({ 'ShyDesk-Appeal': 'notice-token' });
    expect(Object.keys(fields)).toEqual(['Email', 'Message']);
    expect(fields.Email?.getAttribute('aria-describedby')).toBe('shydesk-appeal-email-error');
    expect(fields.Message?.getAttribute('aria-describedby')).toBe('shydesk-appeal-message-error');
    expect(button?.textContent).toBe('Send appeal');
  });

  it('sends an empty token when the link has none', async () => {
    routes['GET appeals'] = () => json({}, 404);
    await mount({ product: 'demo', view: 'appeal' }, 'This link is no longer valid.');
    expect(asked[0]?.init?.headers).toEqual({ 'ShyDesk-Appeal': '' });
  });

  it('says it cannot load when ShyDesk answers with an error', async () => {
    routes['GET appeals'] = () => json({}, 500);
    await mount({ product: 'demo', view: 'appeal' }, 'The support form could not load here.');
  });

  it('says it cannot load when the decision cannot be fetched', async () => {
    await mount({ product: 'demo', view: 'appeal' }, 'The support form could not load here.');
  });

  it.each([
    ['already_appealed', 'An appeal for this decision was already sent.'],
    ['lifted', 'This decision is no longer in force.'],
    ['other', 'The support form could not load here.'],
  ])('offers no appeal of a decision that cannot be appealed (%s)', async (reason, line) => {
    location.hash = '#appeal=notice-token';
    routes['GET appeals'] = () => json({ label: 'Muted', can_appeal: false, reason });
    const { root } = await mount({ product: 'demo', view: 'appeal' }, line);
    expect(root.querySelector('section p')?.textContent).toBe('Muted');
    expect(root.querySelector('form')).toBeNull();
  });

  it('sends the appeal once and shows the private link, mailed', async () => {
    const view = await appeal();
    Object.assign(view.fields.Email ?? {}, { value: 'a@example.com' });
    Object.assign(view.fields.Message ?? {}, { value: 'It was not me' });
    routes['POST appeals'] = () => json({ ticket_url: `${HOST}/t#t=x`, email_sent: true }, 201);
    submit(view.form);
    expect(view.button?.disabled).toBe(true);
    expect(view.status()).toBe('Sending…');
    await vi.waitFor(() => {
      expect(view.status()).toBe('The same link is on its way by email.');
    });
    expect(sent('appeals')).toEqual({ email: 'a@example.com', message: 'It was not me' });
    expect(asked.at(-1)?.init?.headers).toEqual({ 'ShyDesk-Appeal': 'notice-token', 'Content-Type': 'application/json' });
    expect(view.form?.hidden).toBe(true);
    const link = view.root.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`${HOST}/t#t=x`);
    expect(link?.getAttribute('aria-label')).toBe('Private link');
    expect(link?.previousElementSibling?.textContent).toBe('Appeal sent. Keep this private link to follow it:');
  });

  it('says to keep the link when the email could not be sent', async () => {
    const view = await appeal();
    routes['POST appeals'] = () => json({ ticket_url: `${HOST}/t#t=x`, email_sent: false }, 201);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The email could not be sent. Keep this link to follow the request.');
    });
  });

  it('marks each refused field and lets the customer try again', async () => {
    const view = await appeal();
    routes['POST appeals'] = () => json({ errors: { email: 'Enter an email.', other: 'x' } }, 400);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Check the fields marked below.');
    });
    expect(view.root.getElementById('shydesk-appeal-email-error')?.textContent).toBe('Enter an email.');
    expect(view.root.getElementById('shydesk-appeal-message-error')?.textContent).toBe('');
    expect(view.button?.disabled).toBe(false);
    routes['POST appeals'] = () => json({ error: 'already_appealed' }, 409);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('An appeal for this decision was already sent.');
    });
    expect(view.root.getElementById('shydesk-appeal-email-error')?.textContent).toBe('');
  });

  it('says what ShyDesk said when it names no known refusal', async () => {
    const view = await appeal();
    routes['POST appeals'] = () => json({ error: 'Slow down.' }, 429);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('Slow down.');
    });
  });

  it('says the appeal failed when the answer says nothing it can read, or nothing comes back', async () => {
    const view = await appeal();
    routes['POST appeals'] = () => new Response('<html>', { status: 502 });
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The appeal could not be sent. Try again.');
    });
    delete routes['POST appeals'];
    view.root.querySelector<HTMLElement>('p[role="status"]')?.replaceChildren();
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The appeal could not be sent. Try again.');
    });
    expect(view.button?.disabled).toBe(false);
  });

  it('treats a created answer with no link as failed', async () => {
    const view = await appeal();
    routes['POST appeals'] = () => json({}, 201);
    submit(view.form);
    await vi.waitFor(() => {
      expect(view.status()).toBe('The appeal could not be sent. Try again.');
    });
    expect(view.form?.hidden).toBe(false);
  });
});
