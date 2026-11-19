/**
 * The feedback dialog's words, English (`FeedbackStrings`). Data, like
 * `review.en.ts`; `feedback.hr.ts` is the same shape. The web's floating
 * button and the app's sidebar item use `open` too.
 */

export const feedbackUiEn = {
  /** The button / sidebar item that opens the dialog, and its tooltip. */
  open: "Feedback",
  openTitle: "Report a bug, request a feature or ask a question",
  title: "Send feedback",
  kindLabel: "What is it about?",
  kinds: {
    bug: "Bug",
    feature: "Feature",
    question: "Question",
  },
  placeholder: {
    bug: "What happened, and what did you expect?",
    feature: "What would you like Rail to do?",
    question: "What would you like to know?",
  },
  messageLabel: "Description",
  images: "Screenshots",
  addImage: "Add image",
  dropHint: "Drop, paste or add up to 3 images",
  removeImage: (n: number) => `Remove image ${n}`,
  imageAlt: (n: number) => `Screenshot ${n}`,
  emailLabel: "Email for a reply (optional)",
  emailPlaceholder: "you@example.com",
  signedInAs: (email: string) => `We'll reply to ${email}.`,
  send: "Send",
  sending: "Sending…",
  cancel: "Cancel",
  close: "Close",
  sent: "Thanks! We read every report.",
  sendAnother: "Send another",
  errors: {
    empty: "Write a short description first.",
    imageType: "Only PNG, JPEG, WebP or GIF images.",
    imageRead: "That image could not be read.",
    tooMany: "Up to 3 images.",
    invalid_request: "Something in the report was not accepted. Check the email and try again.",
    too_large: "The images are too large. Try fewer or smaller ones.",
    rate_limited: "You've sent several reports in a short time. Please try again later.",
    unavailable: "Feedback could not be sent right now. Please try again in a moment.",
    offline: "No connection. Check your internet and try again.",
  },
};
