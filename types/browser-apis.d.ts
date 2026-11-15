/**
 * Browser APIs that TypeScript's bundled DOM lib does not declare (they are
 * Chromium/WebKit-only). Only the members this app actually touches.
 */

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onresult: ((ev: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface PasswordCredential extends Credential {
  readonly password: string;
  readonly name: string;
}

declare var PasswordCredential: {
  prototype: PasswordCredential;
  new (form: HTMLFormElement): PasswordCredential;
};
