'use client';

import { useEffect, useState } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { formatEther } from 'viem';
import { useSttSwap, type SwapStage } from '@/hooks/useSttSwap';

interface SwapModalProps {
  open: boolean;
  onClose: () => void;
}

const STAGE_LABEL: Record<SwapStage, string> = {
  idle: 'READY',
  'reading-book': 'READING ORDERBOOK…',
  simulating: 'SIMULATING…',
  'awaiting-signature': 'CONFIRM IN WALLET',
  swapping: 'SWAPPING…',
  'awaiting-withdraw': 'CONFIRM WITHDRAW',
  withdrawing: 'WITHDRAWING…',
  done: 'DONE',
  error: 'ERROR',
};

export function SwapModal({ open, onClose }: SwapModalProps) {
  const { address } = useAccount();
  const { data: sttBal } = useBalance({ address, query: { enabled: !!address && open } });
  const { stage, error, result, swap, reset, fmtUsdso } = useSttSwap();
  const [amount, setAmount] = useState('10');

  const busy =
    stage !== 'idle' && stage !== 'done' && stage !== 'error';

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  if (!open) return null;

  const sttStr = sttBal ? Number(formatEther(sttBal.value)).toFixed(3) : '—';

  const setMax = () => {
    if (!sttBal) return;
    // Leave 0.1 STT for gas.
    const reserve = BigInt(1e17);
    const max = sttBal.value > reserve ? sttBal.value - reserve : BigInt(0);
    setAmount(Number(formatEther(max)).toFixed(4));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
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
          <span className="t-display t-up" style={{ fontSize: 16, letterSpacing: '0.18em' }}>
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
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontFamily: 'var(--fnt-mono)',
              fontSize: 16,
              padding: '12px 14px',
              outline: 'none',
              width: '100%',
            }}
          />
        </div>

        <div className="col gap-4">
          <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.12em' }}>
            STATUS · <span style={{ color: stage === 'error' ? 'var(--loss)' : stage === 'done' ? 'var(--win)' : 'var(--text)' }}>{STAGE_LABEL[stage]}</span>
          </span>
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
            <a
              className="t-mono t-xs t-dim"
              href={`https://explorer-v2.testnet.somnia.network/tx/${result.swapHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
            >
              swap tx: {result.swapHash.slice(0, 10)}…{result.swapHash.slice(-8)} ↗
            </a>
          )}
          {result.withdrawHash && (
            <a
              className="t-mono t-xs t-dim"
              href={`https://explorer-v2.testnet.somnia.network/tx/${result.withdrawHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
            >
              withdraw tx: {result.withdrawHash.slice(0, 10)}…{result.withdrawHash.slice(-8)} ↗
            </a>
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
