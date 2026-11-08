/// <reference lib="dom" />
/**
 * The shared support piece (shyden-labs/shydesk#19; how to embed it:
 * docs/embedding.md). A product's support page loads this one script from
 * ShyDesk and places
 *
 *   <shydesk-support product="<id>" view="contact" lang="en"></shydesk-support>
 *
 * The piece draws in its own shadow root, takes its colours and font from the
 * page's `--shydesk-*` custom properties, and calls `/support-api/...` on the
 * ShyDesk host this script came from, so the same file works on live and on
 * Non-Prod. `lang` is accepted and not used until the piece is translated.
 * Cloudflare's Turnstile widget lives in the element's light DOM, shown
 * through a slot, where Turnstile's own script can reach it.
 *
 * A plain script, typed with JSDoc and checked by `tsc`, so it ships as written.
 */
(() => {
  const current = /** @type {HTMLScriptElement | null} */ (document.currentScript);
  if (current === null || customElements.get('shydesk-support') !== undefined) return;
  const HOST = new URL(current.src).origin;
  const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

  /** Everything the customer reads. None says we, us, our, I, me, my, the team or solo (tests/unit/customer-copy.test.ts). */
  const TEXT = {
    loading: 'Loading the support form…',
    cannotLoad: 'The support form could not load here.',
    needsCheck: 'Complete the check below to send.',
    ready: 'Ready to send',
    sending: 'Sending…',
    notSent: 'The request could not be sent. Try again.',
    fixFields: 'Check the fields marked below.',
    sent: 'Request sent. Keep this private link to follow it:',
    mailed: 'The same link is on its way by email.',
    notMailed: 'The email could not be sent. Keep this link to follow the request.',
    email: 'Email',
    subject: 'Subject',
    category: 'Category',
    message: 'Message',
    send: 'Send',
    pick: 'Choose…',
    privateLink: 'Private link',
    status: 'Support status',
    attach: 'Photos and videos',
    attachments: 'Attachments',
    uploading: 'uploading…',
    attached: 'attached',
    tooLong: 'Videos can be up to 30 seconds long.',
    wrongType: 'Only photos and MP4 videos can be attached.',
    tooMany: 'Attach up to 10 files.',
    notUploaded: 'The file could not be uploaded. Try again.',
  };

  /** @type {Record<string, string>} */
  const CATEGORY_LABELS = {
    question: 'Question',
    bug: 'Something is not working',
    account: 'Account',
    payment: 'Payment',
    other: 'Something else',
  };

  const CSS = `
    :host { display: block; font-family: var(--shydesk-font, system-ui, sans-serif); color: var(--shydesk-text, #1b1b1f); }
    .panel { display: grid; gap: 12px; padding: 16px; border-radius: 12px; background: var(--shydesk-background, #ffffff); }
    .field { display: grid; gap: 4px; }
    .attachments { display: grid; gap: 4px; min-height: 1px; overflow-wrap: anywhere; }
    .attachments p { margin: 0; }
    .picker-name { font-weight: 600; }
    ::slotted(input) { font: inherit; min-width: 0; }
    label { display: grid; gap: 4px; font-weight: 600; }
    input, select, textarea { font: inherit; font-weight: 400; padding: 10px; min-width: 0; border-radius: 8px; border: 1px solid var(--shydesk-border, #c8c8d0); background: #ffffff; color: inherit; }
    textarea { min-height: 140px; resize: vertical; }
    :focus-visible { outline: 3px solid var(--shydesk-accent, #4b3fd8); outline-offset: 2px; }
    button { font: inherit; font-weight: 600; padding: 12px 16px; border: 0; border-radius: 8px; cursor: pointer; background: var(--shydesk-accent, #4b3fd8); color: var(--shydesk-accent-text, #ffffff); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: var(--shydesk-error, #b3261e); font-size: 0.9em; }
    .error:empty { display: none; }
    a { color: var(--shydesk-accent, #4b3fd8); overflow-wrap: anywhere; }
    [hidden] { display: none !important; }
  `;

  /**
   * @typedef {{ label: string, kind: 'text' | 'select', required: boolean, options?: string[] }} SupportField
   * @typedef {{ id: string, name: string, fields: SupportField[] }} SupportType
   * @typedef {{ product: { id: string, name: string }, types: SupportType[], categories: string[], maxAttachments: number, maxVideoSeconds: number, turnstileSiteKey: string }} FormConfig
   * @typedef {{ render(target: HTMLElement, options: Record<string, unknown>): string, reset(widget: string): void }} TurnstileApi
   * @typedef {{ ticketLink?: string, emailSent?: boolean, errors?: Record<string, string>, error?: string }} TicketAnswer
   */

  /** @type {Promise<TurnstileApi> | undefined} */
  let turnstile;
  /** Cloudflare's Turnstile script, loaded once however many pieces the page has. */
  function useTurnstile() {
    turnstile ??= new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = TURNSTILE_URL;
      tag.async = true;
      tag.addEventListener('load', () => {
        const api = /** @type {{ turnstile?: TurnstileApi }} */ (/** @type {unknown} */ (globalThis)).turnstile;
        if (api === undefined) reject(new Error('Turnstile loaded without its API'));
        else resolve(api);
      });
      tag.addEventListener('error', () => {
        reject(new Error('Turnstile could not load'));
      });
      document.head.append(tag);
    });
    return turnstile;
  }

  /**
   * One element with its attributes and children.
   * @param {string} name
   * @param {Record<string, string>} [attributes]
   * @param {(Node | string)[]} [children]
   * @returns {HTMLElement}
   */
  function make(name, attributes = {}, children = []) {
    const node = document.createElement(name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }

  class SupportPiece extends HTMLElement {
    static get observedAttributes() {
      return ['product', 'view', 'lang'];
    }

    constructor() {
      super();
      this.shadow = this.attachShadow({ mode: 'open' });
      this.statusLine = make('p', { role: 'status', 'aria-live': 'polite', 'aria-label': TEXT.status });
      this.token = '';
      this.begun = false;
    }

    connectedCallback() {
      if (this.begun) return;
      this.begun = true;
      this.shadow.append(make('style', {}, [CSS]), this.statusLine);
      void this.load();
    }

    /** @param {string} line */
    tell(line) {
      this.statusLine.textContent = line;
    }

    /** @param {'config' | 'tickets'} route */
    endpoint(route) {
      return `${HOST}/support-api/${route}?product=${encodeURIComponent(this.getAttribute('product') ?? '')}`;
    }

    async load() {
      this.tell(TEXT.loading);
      /** @type {FormConfig} */
      let config;
      try {
        const answer = await fetch(this.endpoint('config'));
        if (!answer.ok) throw new Error(`config answered ${String(answer.status)}`);
        const raw = /** @type {unknown} */ (await answer.json());
        config = /** @type {FormConfig} */ (raw);
      } catch {
        // A page whose origin the product does not allow gets no CORS header, so the browser refuses the answer.
        this.tell(TEXT.cannotLoad);
        return;
      }
      const type = config.types[0];
      if (type === undefined) this.tell(TEXT.cannotLoad);
      else this.buildForm(config, type);
    }

    /**
     * Checks, shrinks and sends one file, saying how it went. Its code loads on the first file picked.
     * @param {File} file
     * @param {FormConfig} config
     * @param {string[]} attachedIds
     * @param {(words: string) => void} say
     */
    async attach(file, config, attachedIds, say) {
      if (attachedIds.length >= config.maxAttachments) {
        say(TEXT.tooMany);
        return;
      }
      const loaded = /** @type {unknown} */ (await import(`${HOST}/embed-media.js`));
      const media = /** @type {typeof import('./embed-media.js')} */ (loaded);
      const shape = media.uploadShape(file.type);
      if (shape === null) {
        say(TEXT.wrongType);
        return;
      }
      /** @type {Blob | null} */
      let chosen = file;
      if (shape.kind === 'video') {
        const seconds = await media.videoSeconds(file);
        if (seconds !== null && seconds > config.maxVideoSeconds) {
          say(TEXT.tooLong);
          return;
        }
      } else {
        const shrunk = await media.shrinkImage(file);
        chosen = shape.mustConvert ? shrunk : media.pickSmaller(file, shrunk);
      }
      if (chosen === null) {
        say(TEXT.wrongType);
        return;
      }
      const sent = await media.uploadAttachment({
        host: HOST,
        product: this.getAttribute('product') ?? '',
        file: chosen,
        kind: shape.kind,
        // A shrunk photo is always a JPEG, whatever was picked.
        mime: chosen === file ? shape.mime : 'image/jpeg',
        thumbnail: await media.thumbnailOf(file, shape.kind),
        onProgress: (done) => {
          say(`${TEXT.uploading} ${String(Math.round(done * 100))} %`);
        },
      });
      attachedIds.push(sent.id);
      say(`${TEXT.attached}, ${String(media.kilobytes(sent.bytes))} KB`);
    }

    /**
     * @param {FormConfig} config
     * @param {SupportType} type
     */
    buildForm(config, type) {
      /** @type {Map<string, HTMLElement>} */
      const errorFor = new Map();
      /**
       * A labelled control with its error line beside the label, so the error never joins the control's name.
       * @param {string} key
       * @param {string} name
       * @param {HTMLElement} control
       */
      const field = (key, name, control) => {
        const error = make('span', { class: 'error', id: `shydesk-error-${String(errorFor.size)}` });
        errorFor.set(key, error);
        control.setAttribute('aria-describedby', error.id);
        return make('div', { class: 'field' }, [make('label', {}, [name, control]), error]);
      };

      const email = /** @type {HTMLInputElement} */ (make('input', { type: 'email', autocomplete: 'email', required: '' }));
      const subject = /** @type {HTMLInputElement} */ (make('input', { type: 'text', maxlength: '150', required: '' }));
      const category = /** @type {HTMLSelectElement} */ (
        make(
          'select',
          {},
          config.categories.map((value) => make('option', { value }, [CATEGORY_LABELS[value] ?? value])),
        )
      );
      const message = /** @type {HTMLTextAreaElement} */ (make('textarea', { maxlength: '10000', required: '' }));
      /** @type {{ label: string, control: HTMLInputElement | HTMLSelectElement }[]} */
      const extras = type.fields.map((f) => {
        const control =
          f.kind === 'select'
            ? /** @type {HTMLSelectElement} */ (
                make('select', {}, [
                  make('option', { value: '' }, [TEXT.pick]),
                  ...(f.options ?? []).map((o) => make('option', { value: o }, [o])),
                ])
              )
            : /** @type {HTMLInputElement} */ (make('input', { type: 'text', maxlength: '1000' }));
        if (f.required) control.setAttribute('required', '');
        return { label: f.label, control };
      });
      const checkError = make('span', { class: 'error' });
      errorFor.set('turnstileToken', checkError);
      const picker = /** @type {HTMLInputElement} */ (
        make('input', { type: 'file', multiple: '', accept: 'image/*,video/*', slot: 'picker', 'aria-label': TEXT.attach })
      );
      const pickerError = make('span', { class: 'error' });
      errorFor.set('attachmentIds', pickerError);
      const attachments = make('div', { class: 'attachments', role: 'status', 'aria-live': 'polite', 'aria-label': TEXT.attachments });
      const send = /** @type {HTMLButtonElement} */ (make('button', { type: 'submit', disabled: '' }, [TEXT.send]));

      const form = make('form', { class: 'panel', novalidate: '' }, [
        field('email', TEXT.email, email),
        field('subject', TEXT.subject, subject),
        field('category', TEXT.category, category),
        field('message', TEXT.message, message),
        ...extras.map((x) => field(`fields.${x.label}`, x.label, x.control)),
        make('div', { class: 'field' }, [
          make('span', { class: 'picker-name' }, [TEXT.attach]),
          make('slot', { name: 'picker' }),
          pickerError,
        ]),
        attachments,
        make('slot', { name: 'turnstile' }),
        checkError,
        send,
      ]);
      this.shadow.insertBefore(form, this.statusLine);
      this.tell(TEXT.needsCheck);

      /** The ids of the files fully uploaded, and how many are still on their way. */
      const attachedIds = /** @type {string[]} */ ([]);
      let uploading = 0;
      const updateSend = () => {
        send.disabled = this.token === '' || uploading > 0;
      };
      /** One at a time, so a phone is never sending several large files at once. */
      let queue = Promise.resolve();
      picker.addEventListener('change', () => {
        for (const file of Array.from(picker.files ?? [])) {
          const line = make('p', {}, [`${file.name}: ${TEXT.uploading}`]);
          attachments.append(line);
          uploading += 1;
          updateSend();
          queue = queue.then(async () => {
            const say = (/** @type {string} */ words) => {
              line.textContent = `${file.name}: ${words}`;
            };
            try {
              await this.attach(file, config, attachedIds, say);
            } catch (error) {
              say(error instanceof Error ? error.message : TEXT.notUploaded);
            }
            uploading -= 1;
            updateSend();
          });
        }
        picker.value = '';
      });

      const holder = make('div', { slot: 'turnstile' });
      // In the light DOM too: WebDriver file input does not reach inside a shadow root on Safari (shyden-labs/shydesk#21).
      this.append(holder, picker);
      /** @type {string | undefined} */
      let widget;
      useTurnstile().then(
        (api) => {
          widget = api.render(holder, {
            sitekey: config.turnstileSiteKey,
            callback: (/** @type {string} */ token) => {
              this.token = token;
              updateSend();
              this.tell(TEXT.ready);
            },
            'expired-callback': () => {
              this.token = '';
              send.disabled = true;
              this.tell(TEXT.needsCheck);
            },
          });
        },
        () => {
          this.tell(TEXT.cannotLoad);
        },
      );

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          for (const line of errorFor.values()) line.textContent = '';
          send.disabled = true;
          this.tell(TEXT.sending);
          /** @type {Response} */
          let answer;
          try {
            answer = await fetch(this.endpoint('tickets'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: email.value,
                subject: subject.value,
                category: category.value,
                message: message.value,
                fields: Object.fromEntries(extras.map((x) => [x.label, x.control.value])),
                attachmentIds: attachedIds,
                turnstileToken: this.token,
              }),
            });
          } catch {
            updateSend();
            this.tell(TEXT.notSent);
            return;
          }
          const raw = /** @type {unknown} */ (await answer.json().catch(() => ({})));
          const body = /** @type {TicketAnswer} */ (raw);
          if (answer.status === 201 && typeof body.ticketLink === 'string') {
            picker.remove();
            this.showLink(form, holder, body.ticketLink, body.emailSent === true);
            return;
          }
          for (const [key, line] of Object.entries(body.errors ?? {})) {
            const target = errorFor.get(key);
            if (target !== undefined) target.textContent = line;
          }
          this.tell(body.errors === undefined ? (body.error ?? TEXT.notSent) : TEXT.fixFields);
          // Each Turnstile token is good for one try; the widget makes a new one.
          this.token = '';
          const id = widget;
          if (id !== undefined) {
            void useTurnstile().then((api) => {
              api.reset(id);
            });
          }
        })();
      });
    }

    /**
     * @param {HTMLElement} form
     * @param {HTMLElement} holder
     * @param {string} link
     * @param {boolean} emailSent
     */
    showLink(form, holder, link, emailSent) {
      form.hidden = true;
      holder.remove();
      const anchor = make('a', { href: link, 'aria-label': TEXT.privateLink }, [link]);
      this.shadow.insertBefore(make('div', { class: 'panel' }, [make('p', {}, [TEXT.sent]), anchor]), this.statusLine);
      this.tell(emailSent ? TEXT.mailed : TEXT.notMailed);
    }
  }

  customElements.define('shydesk-support', SupportPiece);
})();
