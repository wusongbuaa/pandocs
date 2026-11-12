import * as React from "react";
import { Check, Copy, Eye, EyeOff, Upload } from "lucide-react";
import copy from "copy-to-clipboard";
import { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue
} from "@/components/ui/combobox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, failureMessage } from "../api/client";
import { t } from "../i18n";
import { toast } from "./toast";
import "../styles/kit.css";

type Errors = Readonly<Record<string, string>>;

interface FormState {
  readonly errors: Errors;
  clear(name: string): void;
}

const FormContext = React.createContext<FormState | null>(null);

const whatIsWrong = (control: HTMLInputElement | HTMLTextAreaElement): string | null => {
  if (control.required && !control.value.trim()) return t("This is required");
  if (control.validity.valid) return null;
  if (control.validity.patternMismatch && control.dataset.problem) return control.dataset.problem;
  if (control.validity.typeMismatch && control.type === "email") return t("Enter an email address");
  if (control.validity.tooShort) return t("At least {0} {0|character|characters}", control.minLength);
  if (control.validity.rangeUnderflow) return t("At least {0}", (control as HTMLInputElement).min);
  if (control.validity.rangeOverflow) return t("At most {0}", (control as HTMLInputElement).max);
  return t("This does not look right");
};

/** The first problem with each control a person can fix, in the order they appear. */
function problemsIn(form: HTMLFormElement): Errors {
  const found: Record<string, string> = {};
  for (const control of Array.from(form.elements)) {
    if (
      !(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) ||
      !control.name ||
      !control.willValidate
    )
      continue;
    const problem = whatIsWrong(control);
    if (problem && !found[control.name]) found[control.name] = problem;
  }
  return found;
}

/** What the server found wrong, for the fields on this form. An answer about anything else goes to the toast. */
function problemsFrom(error: unknown, form: HTMLFormElement, fieldFor: FormProps["fieldFor"]): Errors | null {
  if (!(error instanceof ApiError)) return null;
  const onField = fieldFor?.(error);
  if (onField && form.elements.namedItem(onField)) return { [onField]: error.message };
  if (!Array.isArray(error.details)) return null;
  const found: Record<string, string> = {};
  for (const issue of error.details as readonly { readonly path?: readonly unknown[]; readonly message?: string }[]) {
    const name = issue.path?.[0];
    if (typeof name === "string" && issue.message && form.elements.namedItem(name)) found[name] = issue.message;
  }
  return Object.keys(found).length > 0 ? found : null;
}

const focusFirst = (form: HTMLFormElement, errors: Errors) => {
  for (const control of Array.from(form.elements)) {
    if (control instanceof HTMLElement && "name" in control && errors[String(control.name)]) {
      control.focus();
      return;
    }
  }
};

export interface FormProps extends Omit<React.ComponentProps<"form">, "onSubmit"> {
  /** Runs once what is on the form looks right. What it throws ends up next to the field it is about, when there is one. */
  readonly onSubmit: () => void | Promise<void>;
  readonly onBusyChange?: (busy: boolean) => void;
  /** Which field an answer from the server is about, for the ones that do not say. */
  readonly fieldFor?: (error: ApiError) => string | undefined;
}

/** Enter submits it, and a problem shows up under the field it belongs to instead of in a toast nobody can connect to anything. */
export function Form({ onSubmit, onBusyChange, fieldFor, children, ...rest }: FormProps) {
  const [errors, setErrors] = React.useState<Errors>({});
  const running = React.useRef(false);
  const state = React.useMemo<FormState>(
    () => ({
      errors,
      clear: name =>
        setErrors(current => {
          if (!current[name]) return current;
          const { [name]: _gone, ...others } = current;
          return others;
        })
    }),
    [errors]
  );
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (running.current) return;
    const form = event.currentTarget;
    const problems = problemsIn(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      focusFirst(form, problems);
      return;
    }
    running.current = true;
    onBusyChange?.(true);
    try {
      await onSubmit();
    } catch (error) {
      const fromServer = problemsFrom(error, form, fieldFor);
      if (fromServer) {
        setErrors(fromServer);
        focusFirst(form, fromServer);
      } else {
        toast(failureMessage(error), "error");
      }
    } finally {
      running.current = false;
      onBusyChange?.(false);
    }
  };
  // The browser's own bubbles are in the browser's language, and only ever about one field at a time.
  return (
    <FormContext.Provider value={state}>
      <form noValidate {...rest} onSubmit={event => void submit(event)}>
        {children}
      </form>
    </FormContext.Provider>
  );
}

interface Labelled {
  readonly label: React.ReactNode;
  readonly description?: React.ReactNode;
  /** A problem known to whoever renders this, rather than found on submitting. */
  readonly error?: string | undefined;
}

function useField({
  name,
  error,
  required
}: {
  readonly name?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
}) {
  const form = React.useContext(FormContext);
  const id = React.useId();
  const fieldName = name ?? id;
  const problem = error ?? form?.errors[fieldName];
  return {
    id,
    name: fieldName,
    problem,
    clear: () => form?.clear(fieldName),
    described: {
      "aria-invalid": problem ? true : undefined,
      "aria-describedby": problem ? `${id}-error` : undefined
    } as const,
    shell: { htmlFor: id, problem, problemId: `${id}-error`, required }
  };
}

/** A label, the control, what it is for and what is wrong with it. The theme's document styles do not reach inside. */
export function FieldShell({
  label,
  description,
  htmlFor,
  problem,
  problemId,
  required,
  className,
  children
}: Labelled & {
  readonly htmlFor?: string;
  readonly problem?: string | undefined;
  readonly problemId?: string;
  readonly required?: boolean | undefined;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Field
      className={`rp-not-doc${className ? ` ${className}` : ""}`}
      data-invalid={problem ? true : undefined}
      data-required={required ? "" : undefined}
    >
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {problem ? <FieldError id={problemId}>{problem}</FieldError> : null}
    </Field>
  );
}

export function TextField({
  label,
  description,
  error,
  name,
  onChange,
  className,
  ...input
}: Labelled & React.ComponentProps<typeof Input>) {
  const field = useField({ name, error, required: input.required });
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <Input
        id={field.id}
        name={field.name}
        {...field.described}
        {...input}
        onChange={event => {
          field.clear();
          onChange?.(event);
        }}
      />
    </FieldShell>
  );
}

export function TextareaField({
  label,
  description,
  error,
  name,
  onChange,
  className,
  mono,
  ...input
}: Labelled & { readonly mono?: boolean } & React.ComponentProps<typeof Textarea>) {
  const field = useField({ name, error, required: input.required });
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <Textarea
        id={field.id}
        name={field.name}
        className={mono ? "font-mono" : undefined}
        {...field.described}
        {...input}
        onChange={event => {
          field.clear();
          onChange?.(event);
        }}
      />
    </FieldShell>
  );
}

export function PasswordField({
  label,
  description,
  error,
  name,
  onChange,
  className,
  ...input
}: Labelled & Omit<React.ComponentProps<"input">, "type">) {
  const field = useField({ name, error, required: input.required });
  const [shown, setShown] = React.useState(false);
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <InputGroup>
        <InputGroupInput
          id={field.id}
          name={field.name}
          {...field.described}
          {...input}
          type={shown ? "text" : "password"}
          onChange={event => {
            field.clear();
            onChange?.(event);
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={shown ? t("Hide") : t("Show")}
            onClick={() => setShown(value => !value)}
          >
            {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FieldShell>
  );
}

/** Something to pass on, such as a link or an address: it can be read and copied, not changed. */
export function CopyField({
  label,
  description,
  value,
  className,
  mono
}: Labelled & { readonly value: string; readonly className?: string; readonly mono?: boolean }) {
  const field = useField({});
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <InputGroup>
        <InputGroupInput
          id={field.id}
          className={mono ? "font-mono" : undefined}
          readOnly
          value={value}
          onFocus={event => event.target.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={t("Copy")}
            onClick={() => {
              copy(value);
              setCopied(true);
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FieldShell>
  );
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  /** How far down a tree this one is, for choosing among pages. */
  readonly depth?: number;
}

/** A dropdown on its own, for where the label is elsewhere: in a table's heading, say. */
export function ChoiceSelect({
  choices,
  value,
  onChange,
  disabled,
  size,
  className,
  id,
  label,
  placeholder,
  invalid
}: {
  readonly choices: readonly Choice[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly size?: "sm" | "default";
  readonly className?: string;
  readonly id?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly invalid?: boolean;
}) {
  const items = React.useMemo(() => Object.fromEntries(choices.map(choice => [choice.value, choice.label])), [choices]);
  return (
    <Select
      modal={false}
      items={items}
      value={value}
      disabled={disabled ?? false}
      onValueChange={next => onChange(String(next ?? ""))}
    >
      <SelectTrigger
        id={id}
        size={size ?? "default"}
        className={className ?? "w-full"}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {choices.map(choice => (
            <SelectItem
              key={choice.value}
              value={choice.value}
              style={choice.depth ? { paddingLeft: `${choice.depth * 14 + 6}px` } : undefined}
            >
              {choice.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function SelectField({
  label,
  description,
  error,
  name,
  required,
  className,
  onChange,
  ...select
}: Labelled & { readonly name?: string; readonly required?: boolean; readonly className?: string } & Omit<
    React.ComponentProps<typeof ChoiceSelect>,
    "id" | "label" | "className" | "invalid"
  >) {
  const field = useField({ name, error, required });
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <ChoiceSelect
        id={field.id}
        invalid={Boolean(field.problem)}
        {...select}
        onChange={value => {
          field.clear();
          onChange(value);
        }}
      />
    </FieldShell>
  );
}

/** A dropdown with a search box, for lists that can grow long: the pages of a space, say. */
export function SearchSelect({
  choices,
  value,
  onChange,
  disabled,
  id,
  label,
  placeholder,
  className,
  children,
  invalid
}: {
  readonly choices: readonly Choice[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly id?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly className?: string;
  readonly children?: React.ReactNode;
  readonly invalid?: boolean;
}) {
  const selected = choices.find(choice => choice.value === value) ?? null;
  return (
    <Combobox
      items={choices as Choice[]}
      value={selected}
      disabled={disabled ?? false}
      onValueChange={(next: Choice | null) => {
        if (next) onChange(next.value);
      }}
    >
      <ComboboxTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        render={
          <Button type="button" variant="outline" className={`justify-between font-normal ${className ?? "w-full"}`} />
        }
      >
        <span className="truncate">
          <ComboboxValue placeholder={placeholder} />
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} aria-label={t("Search")} placeholder={t("Search")} className="m-1 w-auto" />
        <ComboboxEmpty>{t("Nothing found")}</ComboboxEmpty>
        <ComboboxList>
          {(choice: Choice) => (
            <ComboboxItem
              key={choice.value}
              value={choice}
              style={choice.depth ? { paddingLeft: `${choice.depth * 14 + 6}px` } : undefined}
            >
              {choice.label}
            </ComboboxItem>
          )}
        </ComboboxList>
        {children}
      </ComboboxContent>
    </Combobox>
  );
}

export function SearchSelectField({
  label,
  description,
  error,
  name,
  required,
  className,
  onChange,
  ...select
}: Labelled & { readonly name?: string; readonly required?: boolean; readonly className?: string } & Omit<
    React.ComponentProps<typeof SearchSelect>,
    "id" | "label" | "className" | "invalid" | "children"
  >) {
  const field = useField({ name, error, required });
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <SearchSelect
        id={field.id}
        invalid={Boolean(field.problem)}
        {...select}
        onChange={value => {
          field.clear();
          onChange(value);
        }}
      />
    </FieldShell>
  );
}

/** One of many to tick, as in a list of events. */
export function CheckboxField({
  label,
  description,
  checked,
  onChange,
  disabled,
  className
}: Labelled & {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly className?: string;
}) {
  const id = React.useId();
  return (
    <Field
      orientation="horizontal"
      className={`rp-not-doc${className ? ` ${className}` : ""}`}
      data-disabled={disabled ? true : undefined}
    >
      <Checkbox id={id} checked={checked} disabled={disabled ?? false} onCheckedChange={next => onChange(next)} />
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-normal">
          {label}
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

/** A setting that is on or off. */
export function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled,
  className
}: Labelled & {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly className?: string;
}) {
  const id = React.useId();
  return (
    <Field
      orientation="horizontal"
      className={`rp-not-doc items-start justify-between gap-4${className ? ` ${className}` : ""}`}
      data-disabled={disabled ? true : undefined}
    >
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-normal">
          {label}
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled ?? false} onCheckedChange={next => onChange(next)} />
    </Field>
  );
}

export function NumberInput({
  label,
  description,
  error,
  name,
  value,
  onChange,
  min,
  max,
  className
}: Labelled & {
  readonly name?: string;
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
  readonly min?: number;
  readonly max?: number;
  readonly className?: string;
}) {
  const field = useField({ name, error });
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <BaseNumberField.Root
        value={value}
        min={min}
        max={max}
        name={field.name}
        onValueChange={next => {
          field.clear();
          onChange(next);
        }}
      >
        <BaseNumberField.Group className="flex w-32">
          <BaseNumberField.Input
            id={field.id}
            {...field.described}
            className="h-8 w-full min-w-0 rounded-l-lg border border-r-0 border-input bg-transparent px-2.5 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <BaseNumberField.Decrement
            aria-label={t("Less")}
            className="flex size-8 shrink-0 items-center justify-center border border-r-0 border-input text-muted-foreground hover:bg-muted"
          >
            −
          </BaseNumberField.Decrement>
          <BaseNumberField.Increment
            aria-label={t("More")}
            className="flex size-8 shrink-0 items-center justify-center rounded-r-lg border border-input text-muted-foreground hover:bg-muted"
          >
            +
          </BaseNumberField.Increment>
        </BaseNumberField.Group>
      </BaseNumberField.Root>
    </FieldShell>
  );
}

/** Choosing a file, with its name in plain words instead of what each browser says in its own language. */
export function FileField({
  label,
  description,
  error,
  name,
  required,
  accept,
  file,
  onPick,
  className
}: Labelled & {
  readonly name?: string;
  readonly required?: boolean;
  readonly accept?: string;
  readonly file: File | null;
  readonly onPick: (file: File | null) => void;
  readonly className?: string;
}) {
  const field = useField({ name, error, required });
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <div
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-input pr-2.5 pl-1 text-sm aria-invalid:border-destructive"
        aria-invalid={field.problem ? true : undefined}
      >
        <Button id={field.id} type="button" variant="secondary" size="xs" onClick={() => input.current?.click()}>
          <Upload data-icon="inline-start" aria-hidden="true" />
          {t("Choose a file")}
        </Button>
        <span className={file ? "truncate text-foreground" : "truncate text-muted-foreground"}>
          {file ? file.name : t("No file chosen")}
        </span>
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          aria-label={typeof label === "string" ? label : undefined}
          onChange={event => {
            field.clear();
            onPick(event.target.files?.[0] ?? null);
          }}
        />
      </div>
    </FieldShell>
  );
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/iu;

/** The browser's colour panel behind a swatch, next to the value for those who already know it. */
export function ColorField({
  label,
  description,
  error,
  name,
  value,
  placeholder,
  onChange,
  children,
  className
}: Labelled & {
  readonly name?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
  readonly children?: React.ReactNode;
  readonly className?: string;
}) {
  const field = useField({ name, error });
  const shown = HEX_COLOUR.test(value) ? value : placeholder;
  return (
    <FieldShell label={label} description={description} {...field.shell} className={className}>
      <div className="flex items-center gap-2">
        <label
          className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-input"
          style={{ background: shown }}
        >
          <input
            className="absolute inset-0 cursor-pointer opacity-0"
            type="color"
            aria-label={t("Pick a colour")}
            value={shown}
            onChange={event => {
              field.clear();
              onChange(event.target.value);
            }}
          />
        </label>
        <Input
          id={field.id}
          name={field.name}
          className="w-32 font-mono"
          aria-label={t("Colour value")}
          value={value}
          placeholder={placeholder}
          {...field.described}
          onChange={event => {
            field.clear();
            onChange(event.target.value.trim());
          }}
        />
        {children}
      </div>
    </FieldShell>
  );
}
