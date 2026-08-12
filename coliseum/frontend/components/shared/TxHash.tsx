'use client';

import { useState, useCallback, useEffect } from 'react';

const EXPLORER = 'https://explorer-v2.testnet.somnia.network/tx';

/**
 * A transaction hash the user can actually take with them: the truncated form
 * links to the explorer, the full hash stays selectable, and the copy button
 * puts it on the clipboard. Before this, `select-none` on <body> meant a hash
 * could be read but never copied, with no copy affordance anywhere.
 */
export function TxHash({ hash, label }: { hash: `0x${string}` | string; label: string }) {
  const [copied, setCopied] = useState(false);

  // Clear the confirmation on a timer, and cancel it if the component goes away
  // first so we never set state on an unmounted node.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
    } catch {
      // Clipboard is unavailable over plain HTTP and when permission is denied.
      // The hash is selectable either way, so this degrades rather than breaks.
    }
  }, [hash]);

  return (
    <div className="row ai-c gap-8">
      <a
        className="t-mono t-xs t-dim selectable"
        href={`${EXPLORER}/${hash}`}
        target="_blank"
        rel="noreferrer"
        style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
      >
        {label}: {hash.slice(0, 10)}…{hash.slice(-8)} ↗
      </a>
      <button
        type="button"
        className="bk bk-ghost"
        onClick={copy}
        aria-label={`Copy ${label} hash`}
        style={{ padding: '6px 10px', minHeight: 44, fontSize: 11 }}
      >
        {copied ? 'COPIED' : 'COPY'}
      </button>
      {/* Announce the result rather than relying on the button's label change,
          which a screen reader will not read unless focus happens to be there. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} hash copied to clipboard` : ''}
      </span>
    </div>
  );
}
