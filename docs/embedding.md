# Embedding the support piece

Every product takes support requests on its own support page by embedding
ShyDesk's shared piece. The piece talks straight to ShyDesk from the
customer's browser; nothing passes through the product's server, and the
customer never sees a ShyDesk address.

## 1. Set the product up in ShyDesk

In **Admin > Products**, add the product with:

- **Allowed origins**: every exact origin the support page is served from,
  for example `https://shytalk.app` and `https://www.shytalk.app`. Scheme,
  host and port must match exactly; nothing else may call ShyDesk for this
  product.
- **TEST site origins** (optional): the exact origins of the product's TEST
  sites, for example `https://test.shytalk.app`. They are let in like the
  allowed origins, but their tickets reach the live desk marked **TEST**, their
  private link opens the ticket page's path on that TEST site, and the
  customer is told at once that the test version is answered after the live
  one, with no set reply time (shyden-labs/shydesk#263). An origin cannot be
  both allowed and TEST.
- **Ticket page URL**: the page that shows a customer's ticket. The private
  link is this URL followed by `#t=<token>`. The token stays in the fragment,
  so it never reaches any server log.
- A **support type** with any extra fields the form should ask for.

## 2. Add the piece to the support page

```html
<script src="https://shydesk.dpdns.org/embed.js" defer></script>

<shydesk-support product="shytalk" view="contact" lang="en"></shydesk-support>
```

- `product`: the product id from step 1.
- `view`: `contact` shows the contact form. `ticket` shows the conversation
  on a private link (`#t=<token>`), for the product's ticket page. `appeal`
  shows the decision a ban notice link names (`#appeal=<token>`) and takes
  one appeal of it, for the product's appeal page. The tokens stay in the
  fragment, so the product's server never receives them.
- `lang`: the page's language. It is accepted now and used once the piece is
  translated; English is shown until then.

The piece calls the ShyDesk it was loaded from, so a test page loads it from
the Non-Prod ShyDesk (`https://shydesk.<non-prod-subdomain>.workers.dev/embed.js`)
and gets Non-Prod data, with nothing else to change.

## 3. Style it

The piece draws inside its own shadow root, so the page's CSS does not reach
it. It reads these custom properties from the page instead:

| Property                     | Used for                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| `--shydesk-font`             | All text                                                            |
| `--shydesk-text`             | Text colour                                                         |
| `--shydesk-background`       | Form background                                                     |
| `--shydesk-accent`           | The send button and focus ring                                      |
| `--shydesk-accent-text`      | Text on the send button                                             |
| `--shydesk-border`           | Field borders                                                       |
| `--shydesk-field-background` | Field background (default: `--shydesk-background`)                  |
| `--shydesk-field-text`       | Typed text and the list arrow in fields (default: `--shydesk-text`) |
| `--shydesk-error`            | Field error messages                                                |

A page with a dark theme sets `--shydesk-text` and `--shydesk-background`;
the fields follow them, so typed text stays readable. Set the two field
properties only for fields coloured differently from the form.

```css
shydesk-support {
  --shydesk-accent: #5b4bff;
  --shydesk-font: 'Inter', system-ui, sans-serif;
}
```

## What the customer sees

On sending, the piece shows the private link to the request. A notice email
with the same link goes to the address given; if it could not be sent, the
piece says so and asks the customer to keep the link.

## The calls it makes

All under `/support-api/` on the ShyDesk host, each with `?product=<id>`, and
answered only for the product's allowed origins (any other origin gets 404):

- `GET /support-api/config`: the form's settings (types and fields,
  categories, the Turnstile site key, attachment limits).
- `POST /support-api/tickets`: a new request, checked by Turnstile and limited
  to 5 per email and 20 per network address per hour.

## Attachments

The form takes photos and videos. On the first file picked, the piece imports
`/embed-media.js` from the same ShyDesk host, so a page with a Content Security
Policy must allow that host in `script-src` and `connect-src`. Photos are shrunk
in the browser and sent in parts straight to ShyDesk. Videos go as they are for
now (shyden-labs/shydesk#21), and a video over 30 seconds is refused before upload.

## Content Security Policy

The piece needs only these sources on the support and ticket pages, where
`<ShyDesk host>` is the host its script is loaded from:

| Directive     | Sources                                                    |
| ------------- | ---------------------------------------------------------- |
| `script-src`  | `<ShyDesk host>` and `https://challenges.cloudflare.com`   |
| `connect-src` | `<ShyDesk host>`                                           |
| `frame-src`   | `https://challenges.cloudflare.com` (Turnstile)            |
| `img-src`     | `blob:` (previews and the viewer)                          |
| `media-src`   | `blob:`                                                    |

It needs no `style-src 'unsafe-inline'`: the form and the viewer style
themselves with constructed style sheets (`adoptedStyleSheets`), which a
page's `style-src` does not block, and set no `style` attributes
(shyden-labs/shydesk#266). It starts no worker and uses no `data:` URLs.
