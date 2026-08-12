'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { formatEther, parseEther } from 'viem';
import { useSttSwap, type SwapStage } from '@/hooks/useSttSwap';
import { TxHash } from '@/components/shared/TxHash';

interface SwapModalProps {
  open: boolean;
  onClose: () => void;
}

/** Largest single order the SOMI/USDso book reliably fills — see setMax. */
const MAX_FILLABLE_STT = parseEther('50');

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants in DOM order, skipping anything currently hidden. */
function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed',
  );
}

function firstFocusable(root: HTMLElement | null): HTMLElement | undefined {
  return focusableWithin(root)[0];
}

const STAGE_LABEL: Record<SwapStage, string> = {
  idle: 'READY',
  'reading-book': 'READING ORDERBOOK…',
  simulating: 'SIMULATING…',
  'awaiting-signature': 'CONFIRM IN WALLET',
  swapping: 'SWAPPING…',
  'awaiting-withdraw': 'CONFIRM WITHDRAW',
  withdrawing: 'WITHDRAWING…',
  'fallback-awaiting-signature': 'CONFIRM FALLBACK SIGN',
  'fallback-swapping': 'FALLBACK CLAIMING…',
  done: 'DONE',
  error: 'ERROR',
};

export function SwapModal({ open, onClose }: SwapModalProps) {
  const { address } = useAccount();
  const { data: sttBal } = useBalance({ address, query: { enabled: !!address && open } });
  const { stage, attempt, error, result, swap, reset, fmtUsdso } = useSttSwap();
  const [amount, setAmount] = useState('10');

  const busy = stage !== 'idle' && stage !== 'done' && stage !== 'error';

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Move focus into the dialog on open and hand it back on close. Split from the
  // key handler below deliberately: this must depend on `open` alone, or every
  // change of `busy` would tear down and re-run it, yanking focus mid-swap.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    (firstFocusable(dialogRef.current) ?? dialogRef.current)?.focus();
    return () => restoreFocusTo.current?.focus?.();
  }, [open]);

  // Escape to dismiss, and Tab cycling kept inside the dialog. Without this,
  // Tab walked straight out to the page behind while the modal still covered it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Never close mid-transaction: the swap is already in flight and the
        // dialog is the only place its progress is reported.
        if (!busy) { e.preventDefault(); onClose(); }
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusableWithin(dialogRef.current);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const sttStr = sttBal ? Number(formatEther(sttBal.value)).toFixed(3) : '—';

  const setMax = () => {
    if (!sttBal) return;
    // Leave 0.1 STT for gas.
    const reserve = BigInt(1e17);
    let max = sttBal.value > reserve ? sttBal.value - reserve : BigInt(0);
    // Cap at what a single order can actually fill. The book shows far more depth
    // than the maker can deliver: 50 STT fills, 70 rejects regardless of gas. An
    // uncapped MAX on a large balance therefore fails every simulate attempt and
    // silently drops through to the one-shot SwapFallback, handing over 1 USDso
    // instead of the ~34 the balance implies. Swap repeatedly for more.
    if (max > MAX_FILLABLE_STT) max = MAX_FILLABLE_STT;
    setAmount(Number(formatEther(max)).toFixed(4));
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="swap-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,3,10,0.72)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="card"
        style={{
          width: 'min(420px, 92vw)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div className="row jc-sb ai-c">
          <span id="swap-title" className="t-display t-up" style={{ fontSize: 16, letterSpacing: '0.18em' }}>
            SWAP STT → USDso
          </span>
          <button
            className="bk bk-ghost"
            style={{ padding: '4px 10px' }}
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="row jc-sb ai-c">
          <span className="label-tiny">STT BALANCE</span>
          <span className="t-num t-sm">{sttStr}</span>
        </div>

        <div className="col gap-6">
          <div className="row jc-sb ai-c">
            <label className="label-tiny" htmlFor="swap-amount">AMOUNT (STT)</label>
            <button
              className="bk bk-ghost"
              style={{ padding: '2px 8px', fontSize: 10 }}
              onClick={setMax}
              disabled={busy}
            >
              MAX
            </button>
          </div>
          <input
            id="swap-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            style={{
              background: 'var(--bg-card-2)',
              border: '1px solid var(--border-input)',
              color: 'var(--text)',
              fontFamily: 'var(--fnt-mono)',
              fontSize: 16,
              padding: '12px 14px',
              width: '100%',
            }}
          />
        </div>

        <div className="col gap-4">
          <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.12em' }}>
            STATUS · <span style={{ color: stage === 'error' ? 'var(--loss)' : stage === 'done' ? 'var(--win)' : 'var(--text)' }}>{STAGE_LABEL[stage]}</span>
            {attempt && (
              <span style={{ color: 'var(--text-dim)' }}>
                {' · TRY '}
                <span style={{ color: 'var(--text)' }}>{attempt.n}/{attempt.max}</span>
              </span>
            )}
          </span>
          {attempt && (stage === 'reading-book' || stage === 'simulating') && (
            <span className="t-mono t-xs t-dim" style={{ lineHeight: 1.5 }}>
              testnet book is thin — 3 tries, then we fall back to the reserve contract
            </span>
          )}
          {(stage === 'fallback-awaiting-signature' || stage === 'fallback-swapping') && (
            <span className="t-mono t-xs" style={{ color: 'var(--bronze)', lineHeight: 1.5 }}>
              market book empty — using SwapFallback reserve (1 USDso, one per address)
            </span>
          )}
          {result.path === 'fallback' && stage === 'done' && (
            <span className="t-mono t-xs t-dim" style={{ lineHeight: 1.5 }}>
              served via SwapFallback reserve · STT collected funds the seeder bot
            </span>
          )}
          {error && (
            <span className="t-mono t-xs" style={{ color: 'var(--loss)', lineHeight: 1.5 }}>
              {error}
            </span>
          )}
          {stage === 'done' && result.usdsoGained !== undefined && (
            <span className="t-mono t-xs" style={{ color: 'var(--win)' }}>
              + {Number(fmtUsdso(result.usdsoGained)).toFixed(4)} USDso received
            </span>
          )}
          {result.swapHash && (
            <TxHash hash={result.swapHash} label="swap tx" />
          )}
          {result.withdrawHash && (
            <TxHash hash={result.withdrawHash} label="withdraw tx" />
          )}
          {result.fallbackHash && (
            <TxHash hash={result.fallbackHash} label="fallback tx" />
          )}
        </div>

        <button
          className="bk bk-primary"
          style={{ padding: '12px 18px', letterSpacing: '0.12em' }}
          onClick={() => swap(amount)}
          disabled={busy || !address}
        >
          {busy ? '…' : stage === 'done' ? 'SWAP AGAIN' : 'SWAP →'}
        </button>
      </div>
    </div>
  );
}
