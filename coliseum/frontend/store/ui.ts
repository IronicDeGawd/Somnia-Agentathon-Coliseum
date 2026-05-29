import { create } from 'zustand';

type Palette = 'violet' | 'noir' | 'amber';
type LayoutMode = 'split' | 'oneUp' | 'stacked';
type PortraitStyle = 'shield' | 'tarot' | 'helm';

interface UIState {
  palette: Palette;
  layout: LayoutMode;
  portrait: PortraitStyle;
  showCrtScanlines: boolean;
  audioOn: boolean;
  setPalette: (palette: Palette) => void;
  setLayout: (layout: LayoutMode) => void;
  setPortrait: (portrait: PortraitStyle) => void;
  toggleCrtScanlines: () => void;
  toggleAudio: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  palette: 'violet',
  layout: 'split',
  portrait: 'shield',
  showCrtScanlines: true,
  audioOn: true,
  setPalette: (palette) => {
    if (typeof window !== 'undefined') {
      document.documentElement.setAttribute('data-palette', palette);
    }
    set({ palette });
  },
  setLayout: (layout) => set({ layout }),
  setPortrait: (portrait) => set({ portrait }),
  toggleCrtScanlines: () => set((state) => ({ showCrtScanlines: !state.showCrtScanlines })),
  toggleAudio: () => set((state) => ({ audioOn: !state.audioOn })),
}));
