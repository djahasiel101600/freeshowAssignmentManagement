export interface TitlePairLike {
  id: string;
  variableName: string;
  title: string;
}

export interface MessageLayout {
  header: string;
  footer: string;
}

export const GLOBAL_MESSAGE_LAYOUT_KEY = 'globalMessageLayout';

export function loadGlobalLayout(): MessageLayout {
  try {
    const raw = localStorage.getItem(GLOBAL_MESSAGE_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        header: typeof parsed?.header === 'string' ? parsed.header : '',
        footer: typeof parsed?.footer === 'string' ? parsed.footer : '',
      };
    }
  } catch {
    // ignore corrupted data
  }
  return { header: '', footer: '' };
}

export function saveGlobalLayout(layout: MessageLayout): void {
  localStorage.setItem(GLOBAL_MESSAGE_LAYOUT_KEY, JSON.stringify(layout));
}

export interface BuildMessageInput {
  content: string;
  variables: Array<{ name: string; value: string }>;
  variableTitlePairs?: TitlePairLike[];
  /**
   * Optional per-message value overrides. These win over the live variable
   * values so a previewed message stays identical to what gets sent.
   */
  overrides?: Record<string, string>;
  /**
   * Global header/footer applied around every message. Defaults to whatever
   * is saved in localStorage (so the composer, conditional sender, and any
   * other caller stay in sync). Pass `null` to skip the layout entirely.
   */
  layout?: MessageLayout | null;
}

function renderSection(
  text: string,
  variablesObj: Record<string, string>,
  variableTitlePairs: TitlePairLike[]
): string {
  let rendered = text.replace(/\{\{(\w+)\}\}/g, (match, variableName: string) =>
    variablesObj[variableName] !== undefined ? variablesObj[variableName] : match
  );

  for (const pair of variableTitlePairs) {
    const value = variablesObj[pair.variableName] || '';
    rendered = rendered.replace(
      new RegExp(`\\{\\{TITLE_PAIR_${pair.id}\\}\\}`, 'g'),
      `${pair.title || pair.variableName}: ${value}`
    );
  }

  return rendered;
}

/**
 * Renders a message template the same way across the app:
 *   1. `{{variableName}}` placeholders are replaced with current variable values.
 *   2. `{{TITLE_PAIR_id}}` placeholders are replaced with `"title: value"`.
 * Any `overrides` take precedence for specific variable names.
 * Finally, the saved global header/footer is wrapped around the message
 * (placeholders inside the header/footer are resolved too).
 */
export function buildMessageFromTemplate({
  content,
  variables,
  variableTitlePairs = [],
  overrides = {},
  layout,
}: BuildMessageInput): string {
  const variablesObj: Record<string, string> = {};
  for (const variable of variables) {
    variablesObj[variable.name] = variable.value ?? '';
  }
  Object.assign(variablesObj, overrides);

  let message = renderSection(content, variablesObj, variableTitlePairs);

  const resolvedLayout = layout === undefined ? loadGlobalLayout() : (layout ?? { header: '', footer: '' });
  const header = resolvedLayout?.header || '';
  const footer = resolvedLayout?.footer || '';

  if (header || footer) {
    const renderedHeader = renderSection(header, variablesObj, variableTitlePairs)
      .replace(/\n+$/g, '');
    const renderedFooter = renderSection(footer, variablesObj, variableTitlePairs)
      .replace(/^\n+/g, '');
    message = `${renderedHeader}\n${message}\n${renderedFooter}`;
  }

  return message.trimEnd();
}