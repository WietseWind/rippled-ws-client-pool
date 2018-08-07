# rippled-ws-client-pool

Client side auto failover, health monitoring rippled (XRPL) client using websockets. A development GUI/debugging dashboard/implementation can be found [here](https://github.com/WietseWind/rippled-ws-client-dashboard) (the pool implementation [here](https://github.com/WietseWind/rippled-ws-client-dashboard/blob/master/src/components/Dashboard.vue#L480) starting at line ~480).

### You can see it in action at https://xrp.fans

### Dependencies 

 - [rippled-ws-client](https://github.com/WietseWind/rippled-ws-client) ([npm](https://www.npmjs.com/package/rippled-ws-client))
 - [websocket](https://www.npmjs.com/package/websocket) when running in a non-browser environment

##### Can be used with

 - [rippled-ws-client-sign](https://github.com/WietseWind/rippled-ws-client-sign) ([npm](https://www.npmjs.com/package/rippled-ws-client-sign))

##### To compile for the browser:

```
./node_modules/.bin/browserify -t  [ babelify --presets [ es2015 ] ] -r .:rippled-ws-client-pool -o dist/rippled-ws-client-pool.js
```

The output will be in the `dist` folder. You can use it in your project [like this](https://gist.github.com/WietseWind/b8879a123b432485f68a3e4a1139af23).

# API

The pool offers an object with some getters and setters and **events**. Multiple pools can be configured simultaneously. All methods interacting with one of the configured _rippled_-servers return a _Promise_.

You create a new ConnectionPool using:

```
import RippledWsClientPool from 'rippled-ws-client-pool'

connectionPool = new RippledWsClientPool()
```

You call methods using:

```
connectionPool.addServer('wss://s1.ripple.com')
```

You send commands (returns _Promise_) using:

```
connectionPool.send({
  command: 'server_info'
}, {
  serverTimeout: 1500,
  overallTimeout: 10000
}).then(response => {
  console.log('Response', response)
}).catch(error => {
  console.log('Error', error.message)
})

```

You subscribe to events using:

```
connectionPool.on('ledger', (ledger) => {
  console.log('Ledger closed', ledger)
})
```

## Events

 - **`ledger`** One of the _rippled_ servers in the pool reported a new closed ledger. Data: `(int) ledger_index`
 - **`added`** A _rippled_ host (websocket connection) is added to the pool. Note: the host may be down, you don't know the host status yet. Data: `(string) hostname`
 - **`removed`** A _rippled_ host (websocket connection) is removed and disconnected from the pool. Data: `(string) hostname`
 - **`hostinfo`** Every ~2.5 seconds the pool will emit state information about hosts. You can use this data to plot health (if you'd like). All hosts will report `hostinfo`. Data: `(object) hostinfo`
 - **`transaction`** When a transaction (in / out) hits one of the watched (subscribed) accounts. When you **send** a transaction, the account will automatically be watched (subscribed). - See: _"Add and remove accounts to be watched"_

## Add and remove servers from the pool

#### Add (void) - emits `added`:

```
connectionPool.addServer('wss://s1.ripple.com')
```

If the protocol (`ws://` / `wss://` is omitted, `wss://` will be assumed)

#### Remove (void) - emits `removed`:

```
connectionPool.removeServer('wss://s1.ripple.com')
```

## Get Health Ranking

```
connectionPool.getRanking()
```

## Add and remove accounts to be watched

This will send the `{ command: 'subscribe', account: 'rXXXXXX...' }` under the hood (or `unsubscribe`, of course.

When a transaction is sent, the transaction account will be auto-watched (no need to subscribe for the account). After the transaction is sent and processed, the account will still be watched until the `unsubscribeAccount` method will be called.

#### Add account to be watched (void):

```
connectionPool.subscribeAccount('rXXXXXXX...')
```

If the account is already watched, it this command will be ignored.


#### Remove watched account (void):

```
connectionPool.unsubscribeAccount('rXXXXXXX...')
```

## Get Transactions

```
connectionPool.getTransactions(account, Options)
```

eg. - with default `Options` 

```
connectionPool.getTransactions('rXXXXXXX...', {
  ledger_index_min: -1,
  ledger_index_max: -1,
  limit: 100,
  forward: false,
  marker: null,
  ledger_hash: null,
  ledger_index: null
})
```

If you specify the `account` key in the `Options` object, this will overrule the first argument.

Specifing a `marker` is not required if you use the `more()` method on the response of a previous `getTransactions` call.

The `getTransactions` method will return an object with:

 - **`account`** - The transaction account (string)
 - **`transactions`** - The transactions (array)
 - **`more()`** - Auto-marker: fetch the next page, auto-marker (method)

## Sending commands

You can send a command to the pool using the `send(Command, Options)` method. The command may be sent to multiple _rippled_ servers. The _rippled_ servers connected to the pool will be queried in order (by health, waterfalled). The next server will be queried when the previous server timed out or responded with an error, except when the error is one of:

 - `unknownCmd`
 - `invalidParams`
 - `actMalformed`
 - `lgrIdxsInvalid`

... in which case querying another server will guarantee the same result.

The `send(Command, Options)` method will return a _Promise_;

 - `Command` should be an object (see [Ripple docs](https://developers.ripple.com/public-rippled-methods.html))
 - `Options` are documented below (_"Sending commands: Options"_)

#### Sample
```
connectionPool.send({
  command: 'account_info',
  account: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
})
```

### Sending commands: Options

You can specify options:

```
connectionPool.send({
  command: 'account_info',
  account: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
}, {
  idempotency: 123,
  serverTimeout: 1500,
  overallTimeout: 10000
})
```

#### idempotency

If you allow a user to send another query while a previous query might still be in process, you can determine if you want to render results of an older request.

#### serverTimeout (ms)

Default: `1000` (1 sec.)

The timeout per server in the pool, after this timeout the next server will be queried. The first server to respond will resolve the promise, even if the next server has been queried already.

#### overallTimeout (ms)

Default: `5000` (5 sec.)

The overall timeout, after this timeout the promise will be rejected.

## Submitting Transactions

You probably don't want to submit the transaction to multiple _rippled_, only to the healtiest server. You can get the connection object (with the websocket) for the healthiest server with:

```
connectionPool.getConnection()
```

The connection object you will receive is a `rippled-ws-client` object ([Github](https://github.com/WietseWind/rippled-ws-client)) ([npm](https://www.npmjs.com/package/rippled-ws-client))

You can then call the `send()` method on the connection object. This will return a Promise, resulting in the response returned by the _rippled_ server.

This can easily be combined with [rippled-ws-client-sign](https://github.com/WietseWind/rippled-ws-client-sign) ([npm](https://www.npmjs.com/package/rippled-ws-client-sign)) to sign and submit:

```
let Transaction = ... // XRPL Transaction Object
let SecretOrKey = ... // Family Seed (`sXXXX...`) or Keypair object (`privateKey` and `publicKey`)
let Connection = connectionPool.getConnection()

new RippledWsClientSign(Transaction, SecretOrKey, Connection)
  .then(TransactionSuccess => {
    // ...
  })
  .catch((SignSubmitError) => {
    // ...
  })
```

#### Getting all connection objects with state and preference

If you want to retrieve all connection objects to write your own filter to determine the server to submit your transaction to, you can use the `getConnections()` method:

```
let connections = connectionPool.getConnections()
```

An object will be returned with:

 - **`connection`** with the connection object ([rippled-ws-client](https://github.com/WietseWind/rippled-ws-client-sign) - [npm](https://www.npmjs.com/package/rippled-ws-client))
 - **`hostname`**
 - **`state`** the state object with all the health monitoring metrics
 - **`preference`** the preference index in the pool (based on the server health)

 
