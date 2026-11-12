import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { app } from "../data/runtime-data";
import { logoOf } from "../data/site";
import { useCoveredPage } from "../ui/covered-page";
import { language, t } from "../i18n";
import { loginPageFor, type SignInRequest } from "./sign-in";
import "../styles/kit.css";
import { insideSite, sitePath } from "../data/site-base";

interface LoginOptions {
  readonly signedIn: boolean;
  readonly passwordLogin: boolean;
  readonly setup: boolean;
  readonly providers: readonly { readonly id: string; readonly name: string }[];
}

/** The sign-in routes answer with data when asked for it, in the language the page is in. */
const ASKING_FOR_DATA = { accept: "application/json", "accept-language": language };

const here = () => `${location.pathname}${location.search}${location.hash}`;

/** Everything on a page depends on who is reading it, so once someone has signed in it is built again for them. */
function carryOn(next: string): void {
  if (next === here()) location.reload();
  else location.assign(next);
}

let styleLoaded: Promise<void> | null = null;

/** The sign-in pages' own stylesheet, which makes this the same card. Without it the form is plain, and still works. */
function loadSignInStyle(): Promise<void> {
  styleLoaded ??= new Promise(done => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = sitePath("/sign-in.css");
    link.onload = () => done();
    link.onerror = () => done();
    document.head.append(link);
  });
  return styleLoaded;
}

async function loginOptions(): Promise<LoginOptions> {
  const response = await fetch(sitePath("/login"), { credentials: "same-origin", headers: ASKING_FOR_DATA });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { data: LoginOptions }).data;
}

/** The first problem with a field a person can fix, in the app's words rather than the browser's. */
function problemWith(input: HTMLInputElement | null): string | undefined {
  if (!input) return undefined;
  if (!input.value.trim()) return t("This is required");
  if (input.validity.typeMismatch) return t("Enter an email address");
  return undefined;
}

/** Waits for how the site signs people in and for the card's look, so that it opens once, ready. */
export default function SignInDialog({ request, onClose }: { readonly request: SignInRequest; readonly onClose: () => void }) {
  const next = request.next ?? here();
  const [options, setOptions] = React.useState<LoginOptions | null>(null);
  React.useEffect(() => {
    let current = true;
    Promise.all([loginOptions(), loadSignInStyle()]).then(
      ([data]) => {
        if (!current) return;
        // Signed in meanwhile in another tab, or a site with nobody yet, which only its own page sets up.
        if (data.signedIn) carryOn(next);
        else if (data.setup) location.assign(loginPageFor(next));
        else setOptions(data);
      },
      // The sign-in page does all of this too, and does not need the app.
      () => {
        if (current) location.assign(loginPageFor(next));
      }
    );
    return () => {
      current = false;
    };
  }, [next]);
  return options ? <SignInCard options={options} request={request} next={next} onClose={onClose} /> : null;
}

/** The sign-in page's card over the page someone was reading: the same parts and words, and the same answers. */
function SignInCard({ options, request, next, onClose }: { readonly options: LoginOptions; readonly request: SignInRequest; readonly next: string; readonly onClose: () => void }) {
  useCoveredPage();
  const { site } = app.bootstrap;
  const id = React.useId();
  const emailRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const [problems, setProblems] = React.useState<{ readonly email?: string | undefined; readonly password?: string | undefined }>({});
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const lead = request.reason ?? site.description;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const found = { email: problemWith(emailRef.current), password: problemWith(passwordRef.current) };
    setProblems(found);
    if (found.email || found.password) {
      (found.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setProblem(null);
    setBusy(true);
    const response = await fetch(sitePath("/login"), {
      method: "POST",
      credentials: "same-origin",
      headers: { ...ASKING_FOR_DATA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: emailRef.current?.value.trim() ?? "", password: passwordRef.current?.value ?? "" })
    }).catch(() => null);
    // Signed in, it stays busy until the page it goes to has come.
    if (response?.ok) {
      carryOn(next);
      return;
    }
    const payload = (await response?.json().catch(() => null)) as { error?: { message?: string } } | null | undefined;
    setProblem(payload?.error?.message ?? t("That did not finish. Try again later."));
    setBusy(false);
    passwordRef.current?.focus();
  };

  const field = (name: "email" | "password", label: string, input: React.ComponentProps<"input">, aside?: React.ReactNode) => {
    const fieldId = `${id}-${name}`;
    const said = problems[name];
    const labelled = <label className="pd-sign-in__label" htmlFor={fieldId}>{label}</label>;
    return (
      <div className="pd-sign-in__field">
        {aside ? <div className="pd-sign-in__label-row">{labelled}{aside}</div> : labelled}
        <input
          ref={name === "email" ? emailRef : passwordRef}
          className="pd-sign-in__input"
          id={fieldId}
          name={name}
          required
          aria-invalid={said ? true : undefined}
          aria-describedby={said ? `${fieldId}-problem` : undefined}
          onChange={() => { if (said) setProblems(current => ({ ...current, [name]: undefined })); }}
          {...input}
        />
        {said ? <p className="pd-sign-in__field-problem" id={`${fieldId}-problem`}>{said}</p> : null}
      </div>
    );
  };

  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <div className="pd-sign-in-dialog">
          <DialogPrimitive.Popup className="pd-sign-in duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <div className="pd-sign-in__logo"><img src={logoOf(site)} alt="" width={64} height={64} /></div>
            <DialogPrimitive.Title className="pd-sign-in__title">{t("Sign in to {0}", site.title)}</DialogPrimitive.Title>
            {lead ? <DialogPrimitive.Description className="pd-sign-in__lead">{lead}</DialogPrimitive.Description> : null}
            {problem ? <p className="pd-sign-in__problem" role="alert">{problem}</p> : null}
            {options.providers.length > 0 ? (
              <div className="pd-sign-in__providers">
                {options.providers.map(provider => (
                  <a key={provider.id} className="pd-sign-in__provider" href={sitePath(`/auth/${encodeURIComponent(provider.id)}/start?${new URLSearchParams({ next: insideSite(next) })}`)}>{t("Sign in with {0}", provider.name)}</a>
                ))}
              </div>
            ) : null}
            {options.providers.length > 0 && options.passwordLogin ? <p className="pd-sign-in__or">{t("or")}</p> : null}
            {options.passwordLogin ? (
              <form className="pd-sign-in__form" noValidate onSubmit={event => void submit(event)}>
                {field("email", t("Email"), { type: "email", autoComplete: "username" })}
                {field("password", t("Password"), { type: "password", autoComplete: "current-password" }, <a className="pd-sign-in__aside" href={sitePath("/forgot-password")}>{t("Forgot your password?")}</a>)}
                <button className="pd-sign-in__submit" type="submit" disabled={busy}>{busy ? t("Signing in…") : t("Sign in")}</button>
              </form>
            ) : null}
            {/* Accounts come from the company's provider when there is one, so only a site of passwords needs telling who makes them. */}
            {options.providers.length === 0 ? <p className="pd-sign-in__note">{t("No account yet? Ask an administrator of this site.")}</p> : null}
            {/* Last, so that opening it starts on what it asks for rather than on leaving it. */}
            <DialogPrimitive.Close className="pd-sign-in__close" aria-label={t("Close")}><X size={16} aria-hidden="true" /></DialogPrimitive.Close>
          </DialogPrimitive.Popup>
        </div>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
