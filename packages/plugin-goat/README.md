# Autonomous Trading Plugin

Autonomous trading plugin for Solana with built-in safety limits and risk management.

## Features

- Automated trading based on market conditions
- Built-in safety limits and position sizing
- Stop loss protection
- Trust score evaluation
- Liquidity monitoring

## Safety Limits

The plugin enforces several safety limits to protect trades:

```typescript
const SAFETY_LIMITS = {
    MINIMUM_TRADE: 0.01,        // Minimum trade size in SOL
    MAX_POSITION_SIZE: 0.1,     // Maximum 10% of token liquidity
    MAX_SLIPPAGE: 0.05,        // Maximum 5% slippage allowed
    MIN_LIQUIDITY: 5000,       // Minimum $5000 liquidity required
    MIN_VOLUME: 10000,         // Minimum $10000 24h volume required
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
    MAX_PRICE_IMPACT: 0.03,    // Maximum 3% price impact allowed
    STOP_LOSS: 0.15,          // 15% stop loss trigger
    CHECK_INTERVAL: 5 * 60 * 1000  // Check every 5 minutes
}
```

## Position Sizing

Trades are limited by two factors:
1. Maximum 10% of token's available liquidity
2. Maximum 10% of wallet's SOL balance

The smaller of these two limits is used as the maximum position size.

## Trust Score Evaluation

Each trade opportunity is evaluated based on:
- Liquidity (40% weight)
- 24h Volume (40% weight)
- Market Cap (20% weight)

## Installation

```bash
pnpm add @goat-sdk/plugin-goat
```

## Configuration

Required environment variables:
```
WALLET_PUBLIC_KEY=your_solana_public_key
WALLET_PRIVATE_KEY=your_solana_private_key
RPC_URL=your_rpc_url
```

## Safety Features

- Minimum trade size enforcement
- Maximum position size limits
- Slippage protection
- Stop loss monitoring
- Liquidity requirements
- Volume requirements
- Trust score evaluation

## Error Handling

- Graceful failure for low funds
- Transaction validation
- Quote verification
- Detailed error logging

## Monitoring

The plugin logs detailed information about:
- Trade execution
- Position management
- Trust evaluation
- Balance checks
- Error conditions
