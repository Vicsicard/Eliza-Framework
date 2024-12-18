# Autonomous Trading Bot Documentation

## Overview

The NeoTrader Plugin implements an autonomous trading bot for executing trades on the Solana blockchain. It provides automated monitoring of market conditions, position management, and trade execution with built-in risk management and safety features.

## Core Components

### Safety Limits

The bot operates within strict safety parameters defined in `SAFETY_LIMITS`:

```typescript
const SAFETY_LIMITS = {
    MINIMUM_TRADE: 0.01,        // Minimum trade size in SOL
    MAX_POSITION_SIZE: 0.1,     // Maximum 10% of token liquidity
    MAX_SLIPPAGE: 0.05,        // Maximum 5% slippage allowed
    MIN_LIQUIDITY: 5000,       // Minimum $5000 liquidity required
    MIN_VOLUME: 10000,         // Minimum $10000 24h volume required
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
    STOP_LOSS: 0.20,          // 20% stop loss trigger
    CHECK_INTERVAL: 5 * 60 * 1000,  // Check every 5 minutes
    TAKE_PROFIT: 0.12,         // Take profit at 12% gain
    TRAILING_STOP: 0.20,       // 20% trailing stop loss
    PARTIAL_TAKE: 0.06,        // Take 6% profit at 6% gain
}
```

### Position Management

Positions are tracked using the `Position` interface:

```typescript
interface Position {
    token: string;              // Token symbol
    tokenAddress: string;       // Token address
    entryPrice: number;         // Entry price in USD
    amount: number;             // Position size
    timestamp: number;          // Entry timestamp
    sold?: boolean;             // Position closed flag
    exitPrice?: number;         // Exit price if sold
    exitTimestamp?: number;     // Exit timestamp if sold
    initialMetrics: {
        trustScore: number;     // Initial trust score
        volume24h: number;      // 24h volume at entry
        liquidity: { usd: number }; // Liquidity at entry
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
    };
    highestPrice?: number;      // Highest price for trailing stop
    partialTakeProfit?: boolean; // Partial profit taken flag
}
```

## Key Features

### 1. Autonomous Trading

The bot implements autonomous trading through the `autonomousTradeAction` which:
- Monitors market conditions continuously
- Evaluates trading opportunities based on configurable criteria
- Manages existing positions with automated risk management
- Executes trades when conditions are met

### 2. Risk Management

Multiple risk management features are implemented:
- Stop loss protection at 20%
- Trailing stop loss at 20% from highest price
- Take profit at 12% gain
- Partial profit taking at 6% gain
- Maximum position sizing based on liquidity
- Minimum liquidity and volume requirements
- Trust score evaluation for each trade

### 3. Trust Evaluation

The `evaluateTrust` function calculates a trust score based on:
- Liquidity (40% weight)
- 24-hour volume (40% weight)
- Market cap (20% weight)

### 4. Trade Execution

The `executeTrade` function handles:
- Slippage protection
- Gas optimization
- Transaction retry logic
- Error handling
- Confirmation verification

### 5. Position Monitoring

Continuous position monitoring includes:
- Price change tracking
- Profit/loss calculation
- Stop loss monitoring
- Take profit evaluation
- Trailing stop adjustment

### 6. Social Integration

Trade notifications are automatically posted to Twitter via the `tweetTradeUpdate` function, including:
- Trade direction (buy/sell)
- Token symbol
- Amount traded
- Price
- Profit/loss for sells
- Transaction link

## Usage

### Configuration Requirements

1. Wallet Configuration:
```typescript
const walletAddress = runtime.getSetting("WALLET_PUBLIC_KEY");
const privateKeyString = runtime.getSetting("WALLET_PRIVATE_KEY");
```

2. RPC Configuration:
```typescript
const connection = new Connection(
    runtime.getSetting("RPC_URL") || "https://api.mainnet-beta.solana.com"
);
```

### Starting the Bot

The bot can be started using:
```typescript
await autonomousTradeAction.handler(
    runtime,
    { content: { source: "auto" } } as Memory,
    undefined,
    undefined,
    callback
);
```

## Error Handling

The bot implements comprehensive error handling:
- Transaction failures
- API errors
- Network issues
- Invalid responses
- Wallet errors

All errors are logged via `elizaLogger` for monitoring and debugging.

## Data Persistence

Position data is persisted using the runtime cache manager:
- `loadPositions`: Loads saved positions on startup
- `savePositions`: Saves position updates

## Monitoring and Logging

Extensive logging is implemented throughout using `elizaLogger`:
- Trade execution details
- Position updates
- Error conditions
- Market data
- Performance metrics

## Security Considerations

1. Wallet Validation:
```typescript
const validateWalletAddress = (address: string | undefined): boolean => {
    if (!address) return false;
    try {
        new PublicKey(address);
        return true;
    } catch {
        return false;
    }
};
```

2. Slippage Protection:
- Maximum slippage limit of 5%
- Quote validation before execution
- Transaction simulation

3. Position Size Limits:
- Maximum 10% of token liquidity
- Minimum trade size enforcement
- Balance checks before trading

## Best Practices

1. Always verify wallet configuration before trading
2. Monitor log output for trading activity
3. Regularly check position status
4. Keep private keys secure
5. Monitor gas costs and adjust as needed
6. Review trust scores periodically
7. Keep safety limits updated based on market conditions

## Dependencies

- @solana/web3.js: Solana blockchain interaction
- @goat-sdk/core: GOAT plugin framework
- @ai16z/eliza: Agent runtime and utilities
- @ai16z/client-auto: Automation client
- @ai16z/client-twitter: Social integration
