/**
 * Every message the customer API sends back (shyden-labs/shydesk#19). The
 * piece shows them as they are, so none says we, us, our, I, me, my, the
 * team or solo (tests/unit/customer-copy.test.ts).
 */
export const MESSAGES = {
  badRequest: 'The request could not be read. Reload the page and try again.',
  notFound: 'Not found.',
  emailInvalid: 'Enter a valid email address.',
  subjectRequired: 'Enter a subject.',
  subjectTooLong: 'Keep the subject to 150 characters.',
  categoryInvalid: 'Choose a category from the list.',
  messageRequired: 'Enter a message.',
  messageTooLong: 'Keep the message to 10,000 characters.',
  fieldRequired: 'This field is required.',
  fieldTooLong: 'Keep this to 1,000 characters.',
  fieldChoice: 'Choose an option from the list.',
  tooManyAttachments: 'Attach up to 10 files.',
  attachmentMissing: 'An attachment could not be found. Upload it again.',
  turnstile: 'The check did not pass. Try again.',
  tooMany: 'Too many requests for now. Try again in an hour.',
  unavailable: 'Support requests cannot be taken right now. Try again later.',
} as const;
