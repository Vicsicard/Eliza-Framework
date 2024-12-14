# Autonomous Trading System Documentation
Version 1.1

## Table of Contents
1. [System Overview](#system-overview)
2. [Plugin Architecture](#plugin-architecture)
3. [Core Components](#core-components)
4. [Configuration](#configuration)
5. [Trading Logic](#trading-logic)
6. [Monitoring and Alerts](#monitoring-and-alerts)
7. [Safety Mechanisms](#safety-mechanisms)

## 1. System Overview
The Autonomous Trading System is built on Eliza's plugin architecture, enabling automated token trading on the Solana blockchain. The system integrates:
- GOAT SDK for core blockchain interactions
- Solana Plugin for trading execution
- DexScreener for market data
- Twitter integration for trade alerts
- CoinGecko for additional market data

## 2. Plugin Architecture

### Core Components
- **WalletAdapter**
  - Implements WalletClient interface
  - Handles balance type conversions
  - Manages chain interactions
  - Provides portfolio tracking

- **Plugin-Solana**
  - Wallet management
  - Trade execution
  - Token validation

- **Client-Twitter**
  - Trade notifications
  - Automated alerts

## 3. Core Components

### WalletAdapter Implementation
```typescript
class WalletAdapter implements WalletClient {
    private provider: WalletProvider;

    async balanceOf(tokenAddress: string): Promise<Balance> {
        const rawBalance = await this.provider.balanceOf(tokenAddress);
        const isSol = this.provider.getChain() === "solana";
        return {
            value: BigInt(Math.floor(rawBalance * Math.pow(10, isSol ? 9 : 6))),
            decimals: isSol ? 9 : 6
        };
    }

    getChain(): Chain {
        return "solana" as Chain;
    }

    // Additional trade execution methods...
}
```

### Dependencies
```json
{
    "@ai16z/eliza": "workspace:*",
    "@goat-sdk/core": "0.3.8",
    "@goat-sdk/plugin-coingecko": "^0.1.0",
    "@goat-sdk/plugin-erc20": "0.1.7",
    "@ai16z/client-twitter": "workspace:*",
    "@ai16z/plugin-solana": "workspace:*"
}
```

## 4. Configuration

### Environment Variables
```env
# Solana Configuration
RPC_URL=your_rpc_url
WALLET_PUBLIC_KEY=your_solana_public_key

# DexScreener
DEXSCREENER_WATCHLIST_ID=your_watchlist_id
DEXSCREENER_API_KEY=your_api_key
UPDATE_INTERVAL=300

# Twitter Integration
TWITTER_ENABLED=true
TWITTER_USERNAME=your_username
TWITTER_DRY_RUN=false

# Optional
COINGECKO_API_KEY=your_api_key
```

## 5. Trading Logic

### Safety Limits
```typescript
const SAFETY_LIMITS = {
    MAX_POSITION_SIZE: 0.1,    // 10% of liquidity
    MAX_SLIPPAGE: 0.05,        // 5% slippage
    MIN_LIQUIDITY: 1000,       // $1000 minimum liquidity
    MAX_PRICE_IMPACT: 0.03,    // 3% price impact
    STOP_LOSS: 0.15,           // 15% stop loss
    MIN_TRUST_SCORE: 0.4,      // Minimum trust score
    DETERIORATION_THRESHOLD: 0.2,  // 20% deterioration triggers sell
    MIN_VOLUME_RATIO: 0.5,     // Minimum volume ratio
    MAX_RISK_INCREASE: 0.3     // Maximum risk increase
}
```

### Trade Conditions

#### Buy Conditions
- Token in DexScreener watchlist
- Sufficient liquidity (>$1000)
- Trust score above minimum (>0.4)
- Not currently in position
- Safe position size available

#### Sell Conditions
- Stop Loss Hit (15% drop)
- Metric Deterioration:
  - Price drop >20%
  - Volume drop >20%
  - Liquidity drop >20%
- Risk Increase:
  - Trust score deterioration >30%

## 6. Monitoring and Alerts

### Position Tracking
```typescript
interface Position {
    token: string;
    entryPrice: number;
    amount: number;
    timestamp: number;
    sold?: boolean;
    initialMetrics: {
        trustScore: number;
        volume24h: number;
        liquidity: { usd: number };
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
    };
}
```

### Twitter Alerts
```
🤖 Trade Alert | <time>
<token> | $<amount>
Trust: <score>%
Risk: <level>

📊 Market Data:
24h Change: <+/-percentage>%
Volume: $<amount>M
Liquidity: $<amount>M

#SolanaDefi #Trading <token>
```

## 7. Safety Mechanisms

### Position Management
- Maximum 10% of token liquidity
- Minimum liquidity requirements
- Risk-adjusted position sizing
- Continuous metric monitoring
- Automatic loss prevention

### Error Handling
- Transaction retry logic
- Slippage protection
- Failed trade recovery
- Portfolio balance validation
- Chain interaction verification

### Risk Management
- Trust score evaluation
- Continuous position monitoring
- Automatic stop loss
- Market deterioration checks
- Portfolio diversification limits
