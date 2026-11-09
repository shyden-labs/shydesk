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
    cannotOpen: 'The file viewer could not open. Try again.',
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
    conversation: 'Conversation',
    reply: 'Reply',
    sendReply: 'Send reply',
    replySent: 'Reply sent.',
    notReplied: 'The reply could not be sent. Try again.',
    linkInvalid: 'This link is no longer valid.',
    removed: 'Attachment removed after 30 days.',
    customer: 'You',
    staff: 'Support',
    attachment: 'Attachment',
    video: 'Video',
    preview: 'Attachment preview',
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
    .attachments { min-height: 1px; overflow-wrap: anywhere; white-space: pre-line; }
    .picker-name { font-weight: 600; }
    ::slotted(input) { font: inherit; min-width: 0; }
    label { display: grid; gap: 4px; font-weight: 600; }
    input, select, textarea { font: inherit; font-weight: 400; padding: 10px; min-width: 0; border-radius: 8px; border: 1px solid var(--shydesk-border, #c8c8d0); background: #ffffff; color: inherit; }
    textarea { min-height: 140px; resize: vertical; }
    :focus-visible { outline: 3px solid var(--shydesk-accent, #4b3fd8); outline-offset: 2px; }
    button { font: inherit; font-weight: 600; padding: 12px 16px; border: 0; border-radius: 8px; cursor: pointer; background: var(--shydesk-accent, #4b3fd8); color: var(--shydesk-accent-text, #ffffff); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.preview { padding: 0; background: none; border-radius: 4px; }
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
   * @typedef {{ id: string, mime: string, bytes: number, durationMs: number | null, removed: boolean }} ThreadAttachment
   * @typedef {{ author: 'customer' | 'staff', body: string, createdAt: number, attachments: ThreadAttachment[] }} ThreadMessage
   * @typedef {{ ticket: { subject: string, status: string, createdAt: number }, messages: ThreadMessage[] }} Thread
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

    /** @param {string} route */
    endpoint(route) {
      return `${HOST}/support-api/${route}?product=${encodeURIComponent(this.getAttribute('product') ?? '')}`;
    }

    async load() {
      this.tell(TEXT.loading);
      if (this.getAttribute('view') === 'ticket') {
        await this.loadTicket();
        return;
      }
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
      let chosen;
      if (shape.kind === 'video') {
        const seconds = await media.videoSeconds(file);
        if (seconds !== null && seconds > config.maxVideoSeconds) {
          say(TEXT.tooLong);
          return;
        }
        say(TEXT.uploading);
        chosen = media.pickSmaller(file, await media.shrinkVideo(file));
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
        // A shrunk photo is always a JPEG, whatever was picked; a video is an MP4 either way.
        mime: chosen === file || shape.kind === 'video' ? shape.mime : 'image/jpeg',
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
      const pickerError = make('span', { class: 'error' });
      errorFor.set('attachmentIds', pickerError);
      const uploads = this.attachmentField(config, () => {
        updateSend();
      });
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
        uploads.lines,
        make('slot', { name: 'turnstile' }),
        checkError,
        send,
      ]);
      this.shadow.insertBefore(form, this.statusLine);
      this.tell(TEXT.needsCheck);

      const updateSend = () => {
        send.disabled = this.token === '' || uploads.busy();
      };

      const holder = make('div', { slot: 'turnstile' });
      // In the light DOM too: WebDriver file input does not reach inside a shadow root on Safari (shyden-labs/shydesk#21).
      this.append(holder, uploads.picker);
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
                attachmentIds: uploads.ids,
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
            uploads.picker.remove();
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
     * The file picker and the lines saying how each file is going. Files go one at a
     * time, so a phone is never sending several large files at once.
     * @param {FormConfig} config
     * @param {() => void} changed called when an upload starts or ends
     */
    attachmentField(config, changed) {
      const picker = /** @type {HTMLInputElement} */ (
        make('input', { type: 'file', multiple: '', accept: 'image/*,video/*', slot: 'picker', 'aria-label': TEXT.attach })
      );
      const lines = make('div', { class: 'attachments', role: 'status', 'aria-live': 'polite', 'aria-label': TEXT.attachments });
      /** The ids of the files fully uploaded. */
      const ids = /** @type {string[]} */ ([]);
      /** One line per file, in a single text so the status reads the same on every browser. */
      const said = /** @type {string[]} */ ([]);
      let uploading = 0;
      let queue = Promise.resolve();
      picker.addEventListener('change', () => {
        for (const file of Array.from(picker.files ?? [])) {
          const at = said.length;
          const say = (/** @type {string} */ words) => {
            said[at] = `${file.name}: ${words}`;
            lines.textContent = said.join('\n');
          };
          say(TEXT.uploading);
          uploading += 1;
          changed();
          queue = queue.then(async () => {
            try {
              await this.attach(file, config, ids, say);
            } catch (error) {
              say(error instanceof Error ? error.message : TEXT.notUploaded);
            }
            uploading -= 1;
            changed();
            // Only once nothing still reads a picked file, so the same file can be picked again.
            if (uploading === 0) picker.value = '';
          });
        }
      });
      return {
        picker,
        lines,
        ids,
        busy: () => uploading > 0,
        clear: () => {
          ids.length = 0;
          said.length = 0;
          lines.textContent = '';
        },
      };
    }

    /** The header carrying the link's token: it goes in no URL, so no server log holds it. */
    ticketHeaders() {
      return { Authorization: `Ticket ${new URLSearchParams(location.hash.slice(1)).get('t') ?? ''}` };
    }

    /** The private link's conversation, with the box to answer in. */
    async loadTicket() {
      const thread = make('div', { class: 'panel', role: 'log', 'aria-label': TEXT.conversation });
      if (!(await this.showThread(thread))) return;
      /** @type {FormConfig} */
      let config;
      try {
        const answer = await fetch(this.endpoint('config'));
        if (!answer.ok) throw new Error(`config answered ${String(answer.status)}`);
        const raw = /** @type {unknown} */ (await answer.json());
        config = /** @type {FormConfig} */ (raw);
      } catch {
        this.tell(TEXT.cannotLoad);
        return;
      }
      const box = make('textarea', { 'aria-label': TEXT.reply, required: '' });
      const message = /** @type {HTMLTextAreaElement} */ (box);
      const send = /** @type {HTMLButtonElement} */ (make('button', { type: 'submit' }, [TEXT.sendReply]));
      const uploads = this.attachmentField(config, () => {
        send.disabled = uploads.busy();
      });
      const form = make('form', { class: 'panel' }, [
        box,
        make('div', { class: 'field' }, [make('span', { class: 'picker-name' }, [TEXT.attach]), make('slot', { name: 'picker' })]),
        uploads.lines,
        send,
      ]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          send.disabled = true;
          this.tell(TEXT.sending);
          const said = await this.sendReply(message.value, uploads.ids);
          send.disabled = false;
          if (said !== null) {
            this.tell(said);
            return;
          }
          message.value = '';
          uploads.clear();
          await this.showThread(thread);
          this.tell(TEXT.replySent);
        })();
      });
      // In the light DOM, as on the contact form: WebDriver file input does not reach inside a shadow root on Safari.
      this.append(uploads.picker);
      this.shadow.insertBefore(thread, this.statusLine);
      this.shadow.insertBefore(form, this.statusLine);
      this.tell('');
    }

    /**
     * Sends one reply; null when it went, or the line saying why it did not.
     * @param {string} words
     * @param {string[]} attachmentIds
     * @returns {Promise<string | null>}
     */
    async sendReply(words, attachmentIds) {
      try {
        const answer = await fetch(this.endpoint('ticket/reply'), {
          method: 'POST',
          headers: { ...this.ticketHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: words, attachmentIds }),
        });
        if (answer.status === 201) return null;
        const raw = /** @type {unknown} */ (await answer.json().catch(() => ({})));
        return /** @type {{ error?: string }} */ (raw).error ?? TEXT.notReplied;
      } catch {
        return TEXT.notReplied;
      }
    }

    /**
     * Draws the thread into `into`; false, having said why, if it cannot be read.
     * @param {HTMLElement} into
     * @returns {Promise<boolean>}
     */
    async showThread(into) {
      /** @type {Response} */
      let answer;
      try {
        answer = await fetch(this.endpoint('ticket'), { headers: this.ticketHeaders() });
      } catch {
        this.tell(TEXT.cannotLoad);
        return false;
      }
      if (answer.status === 404) {
        this.tell(TEXT.linkInvalid);
        return false;
      }
      if (!answer.ok) {
        this.tell(TEXT.cannotLoad);
        return false;
      }
      const raw = /** @type {unknown} */ (await answer.json());
      const { ticket, messages } = /** @type {Thread} */ (raw);
      let previews = 0;
      // Every stored file of the thread, in the order the previews show them: the viewer moves through these.
      const stored = messages.flatMap((one) => one.attachments.filter((file) => !file.removed));
      into.replaceChildren(
        make('h2', {}, [ticket.subject]),
        ...messages.map((one) =>
          make('article', {}, [
            make('strong', {}, [one.author === 'staff' ? TEXT.staff : TEXT.customer]),
            make('p', { style: 'white-space: pre-wrap' }, [one.body]),
            ...one.attachments.map((file) => this.attachmentLine(file, file.removed ? previews : ++previews, stored)),
          ]),
        ),
      );
      return true;
    }

    /**
     * A removed attachment's line, or the preview of a stored one.
     * @param {ThreadAttachment} file
     * @param {number} number its place among the previews, so each has its own name
     * @param {ThreadAttachment[]} stored every stored file of the thread, which the viewer moves through
     */
    attachmentLine(file, number, stored) {
      if (file.removed) return make('p', {}, [TEXT.removed]);
      const name = file.mime.startsWith('video/') ? TEXT.video : TEXT.attachment;
      const kind = file.mime.startsWith('video/') ? 'video' : 'photo';
      const picture = make('img', {
        alt: `${TEXT.preview} ${String(number)}`,
        width: '160',
        'aria-label': `${TEXT.preview} ${String(number)}`,
      });
      // A plain image request cannot carry the token, so the preview comes through fetch.
      void fetch(this.endpoint(`files/${encodeURIComponent(file.id)}/thumb`), { headers: this.ticketHeaders() })
        .then((answer) => (answer.ok ? answer.blob() : null))
        .then((blob) => {
          if (blob === null) picture.remove();
          else picture.setAttribute('src', URL.createObjectURL(blob));
        })
        .catch(() => {
          picture.remove();
        });
      // The preview opens the read-only viewer on this file (shyden-labs/shydesk#25).
      const open = make('button', { type: 'button', class: 'preview', 'aria-label': `Open ${kind} ${String(number)}` }, [picture]);
      open.addEventListener('click', () => {
        void this.openViewer(stored, number - 1);
      });
      return make('p', {}, [open, make('br'), `${name}, ${String(Math.ceil(file.bytes / 1000))} KB`]);
    }

    /**
     * Opens the viewer, loaded from ShyDesk on first use, on `stored[start]`.
     * Each file is fetched with the ticket's token when it is first shown,
     * since a plain image or video request cannot carry it, and its copy in
     * the page is dropped when the viewer closes.
     * @param {ThreadAttachment[]} stored
     * @param {number} start
     */
    async openViewer(stored, start) {
      let viewer;
      try {
        const loaded = /** @type {unknown} */ (await import(`${HOST}/embed-viewer.js`));
        viewer = /** @type {typeof import('./embed-viewer.js')} */ (loaded);
      } catch {
        this.tell(TEXT.cannotOpen);
        return;
      }
      /** @type {Map<string, Promise<string>>} */
      const copies = new Map();
      const load = (/** @type {string} */ id) => {
        const known = copies.get(id);
        if (known !== undefined) return known;
        const copy = fetch(this.endpoint(`files/${encodeURIComponent(id)}`), { headers: this.ticketHeaders() }).then(async (answer) => {
          if (!answer.ok) throw new Error(`file ${id}: ${String(answer.status)}`);
          return URL.createObjectURL(await answer.blob());
        });
        copies.set(id, copy);
        return copy;
      };
      viewer.openViewer({
        doc: document,
        host: this.shadow,
        start,
        items: stored.map((file) => ({ mime: file.mime, load: () => load(file.id) })),
        onClose: () => {
          for (const copy of copies.values()) {
            void copy.then(
              (address) => {
                URL.revokeObjectURL(address);
              },
              () => undefined,
            );
          }
        },
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
