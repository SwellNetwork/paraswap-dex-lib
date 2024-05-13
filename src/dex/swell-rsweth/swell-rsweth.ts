import { Interface, JsonFragment } from '@ethersproject/abi';
import { NumberAsString, SwapSide } from '@paraswap/core';
import {
  AdapterExchangeParam,
  Address,
  ExchangePrices,
  Logger,
  PoolLiquidity,
  PoolPrices,
  SimpleExchangeParam,
  Token,
  TransferFeeParams,
} from '../../types';
import { IDex } from '../idex';
import RSWETH_ABI from '../../abi/rswETH.json';
import { ETHER_ADDRESS, Network } from '../../constants';
import { IDexHelper } from '../../dex-helper';
import { SimpleExchange } from '../simple-exchange';
import { BI_POWS } from '../../bigint-constants';
import { AsyncOrSync } from 'ts-essentials';
import { getOnChainState } from './utils';
import { RswethPool } from './rsweth-pool';
import { getDexKeysWithNetwork, isETHAddress } from '../../utils';
import { WethFunctions } from '../weth/types';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import _ from 'lodash';
import { SwellRswETHConfig, Adapters } from './config';

export enum rswETHFunctions {
  deposit = 'deposit',
}

export type SwellRswETHData = {};
export type SwellRswETHParams = {};

export class SwellRswETH
  extends SimpleExchange
  implements IDex<SwellRswETHData, SwellRswETHParams>
{
  static dexKeys = ['SwellRswETH'];
  rswETHInterface: Interface;
  needWrapNative = false;
  hasConstantPriceLargeAmounts: boolean = true;
  rswETHAddress: string;
  eventPool: RswethPool;
  logger: Logger;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(_.pick(SwellRswETHConfig, ['SwellRswETH']));

  constructor(
    protected network: Network,
    dexKey: string,
    protected dexHelper: IDexHelper,
    protected config = SwellRswETHConfig[dexKey][network],
    protected adapters = Adapters[network],
  ) {
    super(dexHelper, 'SwellRswETH');

    this.network = dexHelper.config.data.network;
    this.rswETHInterface = new Interface(RSWETH_ABI as JsonFragment[]);
    this.rswETHAddress = this.config.rswETH.toLowerCase();
    this.logger = dexHelper.getLogger(this.dexKey);
    this.eventPool = new RswethPool(
      this.dexKey,
      dexHelper,
      this.rswETHAddress,
      this.rswETHInterface,
      this.logger,
    );
  }

  async initializePricing(blockNumber: number) {
    const poolState = await getOnChainState(
      this.dexHelper.multiContract,
      this.rswETHAddress,
      this.rswETHInterface,
      blockNumber,
    );

    await this.eventPool.initialize(blockNumber, {
      state: poolState,
    });
  }

  getPoolIdentifierKey(): string {
    return `${ETHER_ADDRESS}_${this.rswETHAddress}`.toLowerCase();
  }

  isEligibleSwap(
    srcToken: Token | string,
    destToken: Token | string,
    side: SwapSide,
  ): boolean {
    if (side === SwapSide.BUY) return false;

    const srcTokenAddress = (
      typeof srcToken === 'string' ? srcToken : srcToken.address
    ).toLowerCase();
    const destTokenAddress = (
      typeof destToken === 'string' ? destToken : destToken.address
    ).toLowerCase();

    return (
      (isETHAddress(srcTokenAddress) || this.isWETH(srcTokenAddress)) &&
      destTokenAddress === this.rswETHAddress
    );
  }

  assertEligibility(
    srcToken: Token | string,
    destToken: Token | string,
    side: SwapSide,
  ) {
    if (!this.isEligibleSwap(srcToken, destToken, side)) {
      throw new Error('Only eth/weth -> rswETH swaps are supported');
    }
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    return this.isEligibleSwap(srcToken, destToken, side)
      ? [this.getPoolIdentifierKey()]
      : [];
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amountsIn: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[] | undefined,
    transferFees?: TransferFeeParams | undefined,
    isFirstSwap?: boolean | undefined,
  ): Promise<ExchangePrices<SwellRswETHData> | null> {
    if (!this.isEligibleSwap(srcToken, destToken, side)) return null;
    if (this.eventPool.getState(blockNumber) === null) return null;

    const unitIn = BI_POWS[18];
    const unitOut = this.eventPool.getPrice(blockNumber, unitIn);
    const amountsOut = amountsIn.map(amountIn =>
      this.eventPool.getPrice(blockNumber, amountIn),
    );

    return [
      {
        prices: amountsOut,
        unit: unitOut,
        data: {},
        exchange: this.dexKey,
        poolIdentifier: this.getPoolIdentifierKey(),
        gasCost: 120_000,
        poolAddresses: [this.rswETHAddress],
      },
    ];
  }

  getAdapterParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: SwellRswETHData,
    side: SwapSide,
  ): AdapterExchangeParam {
    this.assertEligibility(srcToken, destToken, side);

    return {
      targetExchange: this.rswETHAddress, // not used contract side
      payload: '0x',
      networkFee: '0',
    };
  }

  async getSimpleParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: SwellRswETHData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    this.assertEligibility(srcToken, destToken, side);

    const callees = [];
    const calldata = [];
    const values = [];

    if (this.isWETH(srcToken)) {
      // note: apparently ERC20 ABI contains wETH fns (deposit() and withdraw())
      const wethUnwrapData = this.erc20Interface.encodeFunctionData(
        WethFunctions.withdraw,
        [srcAmount],
      );
      callees.push(this.dexHelper.config.data.wrappedNativeTokenAddress);
      calldata.push(wethUnwrapData);
      values.push('0');
    }

    const swapData = this.rswETHInterface.encodeFunctionData(
      rswETHFunctions.deposit,
      [],
    );

    callees.push(this.rswETHAddress);
    calldata.push(swapData);
    values.push(srcAmount);

    return {
      callees,
      calldata,
      values,
      networkFee: '0',
    };
  }

  getCalldataGasCost(
    poolPrices: PoolPrices<SwellRswETHData>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_OVERHEAD + CALLDATA_GAS_COST.LENGTH_SMALL;
  }
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters?.[side] || null;
  }
  getTopPoolsForToken(
    tokenAddress: string,
    limit: number,
  ): AsyncOrSync<PoolLiquidity[]> {
    return [];
  }
}
