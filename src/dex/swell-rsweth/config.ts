import { Network, SwapSide } from '../../constants';
import { DexConfigMap } from '../../types';

type DexParams = {
  rswETH: string;
};

export const SwellRswETHConfig: DexConfigMap<DexParams> = {
  Swell: {
    [Network.MAINNET]: {
      rswETH: '0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0',
    },
  },
};

export const Adapters: {
  [chainId: number]: { [side: string]: { name: string; index: number }[] };
} = {
  [Network.MAINNET]: {
    [SwapSide.SELL]: [
      // TODO
      // {
      //   name: 'Adapter05',
      //   index: 1,
      // },
    ],
  },
};
