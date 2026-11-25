import type { ComponentProps } from "react";
import { Trans } from "react-i18next";

type SafeTransProps = ComponentProps<typeof Trans>;

/**
 * `<Trans>` for strings that interpolate untrusted values (file names,
 * plugin names, workspace names, keybinding labels).
 *
 * The app initializes i18next with `escapeValue: false`, and `<Trans>`
 * substitutes `values` into the translation *before* parsing its tags. A
 * value such as `<strong>x</strong>.txt` would then render as markup, and
 * `a<b.txt` would lose its `<`. Escaping the values first keeps them as
 * text through the tag parser; `shouldUnescape` turns the entities back
 * into the original characters when the text node is rendered.
 */
export function SafeTrans({ tOptions, ...props }: SafeTransProps) {
  return (
    <Trans
      {...props}
      tOptions={{
        ...tOptions,
        interpolation: { ...tOptions?.interpolation, escapeValue: true },
      }}
      shouldUnescape
    />
  );
}
