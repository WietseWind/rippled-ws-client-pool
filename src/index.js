'use strict'

const EventEmitter = require('events')
const RippledWsClient = require('rippled-ws-client')
// const RippledWsClient = require('./rippled-ws-client.js')
// Todo: log first responder

class RippledWsClientPool extends EventEmitter {
  constructor (Config) {
    super()

    const TX_HISTORY_LENGTH = 500

    let Servers = []
    let Connections = {}
    let LastLedger = null
    let WatchAccounts = {}
    let RecentTransactions = []
    let FirstResponders = []

    const GetSocketProtocol = (Endpoint) => {
      let hostname = Endpoint.toLowerCase().trim()
      let protocol
      if (hostname.match(/:\/\//)) {
        protocol = hostname.split('://')[0]
      }
      if (protocol !== 'wss' && protocol !== 'ws') {
        protocol = 'wss'
      }
      return protocol
    }
    const SanitizeHostname = (Endpoint) => {
      let hostname = Endpoint.toLowerCase().trim()
      if (hostname.match(/:\/\//)) {
        hostname = hostname.split('://')[1].replace(/\/+$/, '')
      }
      return hostname
    }

    Object.assign(this, {
      addServer (Endpoint) {
        let protocol = GetSocketProtocol(Endpoint)
        let hostname = SanitizeHostname(Endpoint)
        let existingServer = Servers.indexOf(hostname)
        if (hostname.length > 0 && existingServer < 0) {
          Servers.push(hostname)
          this.emit('added', hostname)
          new RippledWsClient(protocol + '://' + hostname).then((Connection) => {
            Connections[hostname] = { hostname: hostname }
            Connections[hostname].connection = Connection

            const getState = () => {
              Connections[hostname].state = Connection.getState()
              this.emit('hostinfo', Connections[hostname])
            }
            getState()
            let stateInterval = setInterval(getState, 2.5 * 1000)

            const subscribeAccounts = () => {
              if (Object.keys(WatchAccounts).length > 0) {
                Connection.send({
                  command: 'subscribe',
                  accounts: Object.keys(WatchAccounts)
                })
                // Todo: on catch? Server error?
              }
            }
            subscribeAccounts()

            Connection.on('error', (a) => {
              // Do nothing
              // console.log('Error', hostname, a)
              getState()
            })
            Connection.on('retry', (a) => {
              // Do nothing
              getState()
            })
            Connection.on('close', (a) => {
              // Do nothing
              clearInterval(stateInterval)
            })
            Connection.on('reconnect', (a) => {
              // Do nothing
              getState()
              subscribeAccounts()
            })
            Connection.on('state', (a) => {
              // Do nothing
              getState()
            })
            Connection.on('ledger', (a) => {
              // Do nothing
              if (a.ledger_index > LastLedger) {
                LastLedger = a.ledger_index
                this.emit('ledger', LastLedger)
              }
              getState()
            })
            Connection.on('transaction', (c) => {
              // Do nothing
              if ((typeof c.transaction.Account !== 'undefined' && typeof WatchAccounts[c.transaction.Account] !== 'undefined') || (typeof c.transaction.Destination !== 'undefined' && typeof WatchAccounts[c.transaction.Destination] !== 'undefined')) {
                RecentTransactions.splice(TX_HISTORY_LENGTH)
                let CurrentTxIndex = RecentTransactions.map((r) => { return r.Hash }).indexOf(c.transaction.hash)
                if (CurrentTxIndex < 0) {
                  FirstResponders.splice(50)
                  FirstResponders.unshift(hostname)
                  let TxData = {
                    Hash: c.transaction.hash,
                    Data: c,
                    FirstResponder: hostname,
                    SeenBy: [
                      hostname
                    ]
                  }
                  RecentTransactions.unshift(TxData)
                  this.emit('transaction', TxData)
                } else {
                  RecentTransactions[CurrentTxIndex].SeenBy.push(hostname)
                }
              }
            })
            Connection.on('validation', (a) => {
              // Do nothing
            })
          }).catch((error) => {
            // Todo
            console.error('Rippled Client error', hostname, error)
          })
        }
      },
      removeServer (Endpoint) {
        // Todo: unwatchen, unbinden, disconnecten, enz.
        let hostname = SanitizeHostname(Endpoint)
        let serverIndex = Servers.indexOf(hostname)
        if (serverIndex > -1) {
          if (typeof Connections[hostname] !== 'undefined') {
            Connections[hostname].connection.close().then((closeInfo) => {
              console.log('Closed', hostname, closeInfo)
            }).catch((error) => {
              console.log('Close error', hostname, error)
            })
          }
          Servers.splice(serverIndex, 1)
          this.emit('removed', hostname)
        }
      },
      getRanking () {
        let servers = Object.values(Connections).filter((c) => {
          return c.state.online && c.state.ledger
        })
        let hostLength = servers.length
        let highestLedger = 0
        let ledgers = servers.map((c) => { return c.state.ledger.last })
        if (ledgers.length > 0) {
          highestLedger = Math.max.apply(Math, ledgers)
        }
        let serverPoints = {}
        servers.forEach((s) => {
          serverPoints[s.hostname] = 0
        })
        const getServersOrdered = (group, field, factor, reverse) => {
          if (typeof factor === 'undefined' || isNaN(parseFloat(factor))) {
            factor = 1
          }
          let order = servers.sort((a, b) => {
            return a.state[group][field] > b.state[group][field]
          }).map((c) => {
            return c.hostname
          })
          if (typeof reverse !== 'undefined' && reverse) {
            order.reverse()
          }
          let points = {}
          let values = {}
          let prevVal = null
          let prevI = 0
          order.forEach((c, i) => {
            let _i = (Connections[c].state[group][field] === prevVal ? prevI : i)
            points[c] = (hostLength - _i - 1) * parseFloat(factor)
            serverPoints[c] += points[c]
            // Todo: points factor per section, eg. ledger is > important than fee, fee > important than latency
            prevVal = Math.ceil(Connections[c].state[group][field])
            values[c] = prevVal
            if (_i === i) { prevI = i }
          })
          return {
            values: values,
            order: order,
            points: points
          }
        }
        const getLedgerPenalty = () => {
          let points = {}
          let values = {}
          servers.forEach((s) => {
            let ledgerDiff = highestLedger - s.state.ledger.last
            points[s.hostname] = ledgerDiff > 2 ? ledgerDiff * -3 : 0
            if (points[s.hostname] < -20) {
              points[s.hostname] = -20
            }
            serverPoints[s.hostname] += points[s.hostname]
            values[s.hostname] = ledgerDiff
          })
          return {
            values: values,
            points: points
          }
        }
        const getAgoPenalty = (group) => {
          let points = {}
          let values = {}
          servers.forEach((s) => {
            points[s.hostname] = s.state[group].secAgo > 8 ? Math.round(s.state[group].secAgo / 4) * -1 : 0
            if (points[s.hostname] < -20) {
              points[s.hostname] = -20
            }
            serverPoints[s.hostname] += points[s.hostname]
            values[s.hostname] = Math.ceil(s.state[group].last)
          })
          return {
            values: values,
            points: points
          }
        }
        const getFirstResponder = () => {
          let points = {}
          let values = {}
          let order = []
          servers.forEach((s) => {
            values[s.hostname] = FirstResponders.filter((f) => {
              return f === s.hostname
            }).length
            points[s.hostname] = 0
            if (FirstResponders.length > 0) {
              points[s.hostname] = Math.ceil(values[s.hostname] / FirstResponders.length * 10)
            }
            serverPoints[s.hostname] += points[s.hostname]
            order.push({
              hostname: s.hostname,
              points: points[s.hostname]
            })
          })
          return {
            values: values,
            points: points,
            order: order.sort((a, b) => {
              return a.points < b.points
            }).map((c) => {
              return c.hostname
            })
          }
        }
        const getFirstSequentialLedger = () => {
          let points = {}
          let values = {}
          let order = []
          servers.forEach((s) => {
            let validatedLedgers = s.state.ledger.validated
            let firstValidLedger = highestLedger
            if (typeof validatedLedgers === 'string' && validatedLedgers.match(/[0-9]+/)) {
              firstValidLedger = parseInt(s.state.ledger.validated.split(',').reverse()[0].split('-')[0])
            }
            points[s.hostname] = 0
            values[s.hostname] = firstValidLedger
            order.push({
              hostname: s.hostname,
              value: values[s.hostname]
            })
          })
          return {
            values: values,
            points: points,
            order: order.sort((a, b) => {
              let x = a.value
              let y = b.value
              return x < y ? -1 : x > y ? 1 : 0
            }).map((c) => {
              return c.hostname
            })
          }
        }

        return {
          source: {
            uptime: getServersOrdered('server', 'uptime', 2, true),
            latencyLast: getServersOrdered('latencyMs', 'last', 2),
            latencyAvg: getServersOrdered('latencyMs', 'avg', 3),
            firstSeqLedger: getFirstSequentialLedger(),
            ledgerCount: getServersOrdered('ledger', 'count', 2, true),
            feeLast: getServersOrdered('fee', 'last', 1, false),
            feeAvg: getServersOrdered('fee', 'avg', 3, false),
            ledgerDiff: getLedgerPenalty(),
            feeAgo: getAgoPenalty('fee'),
            latencyAgo: getAgoPenalty('latencyMs'),
            firstResp: getFirstResponder()
          },
          highestLedger: highestLedger,
          points: serverPoints,
          ranking: Object.keys(serverPoints).sort((a, b) => { return serverPoints[a] < serverPoints[b] })
        }
      },
      subscribeAccount (Account) {
        if (typeof WatchAccounts[Account] === 'undefined') {
          WatchAccounts[Account] = {
            TxCount: 0
          }
          Object.values(Connections).forEach((c) => {
            c.connection.send({
              command: 'subscribe',
              accounts: [ Account ]
            })
            // Todo: on catch, server error?
          })
        }
      },
      unsubscribeAccount (Account) {
        if (typeof WatchAccounts[Account] !== 'undefined') {
          delete WatchAccounts[Account]
          Object.values(Connections).forEach((c) => {
            c.connection.send({
              command: 'unsubscribe',
              accounts: [ Account ]
            })
            // Todo: on catch, server error?
          })
        }
      },
      getTransactions (Account, CustomOptions) {
        /**
         * Now: just ask the server with the most history
         * Todo: check ledger index (min/max), depending on forward
         * try to check a faster server > min ledger
         */
        let Options = {
          command: 'account_tx',
          account: Account.trim(),
          ledger_index_min: -1,
          ledger_index_max: -1,
          binary: false,
          limit: 100,
          forward: false,
          marker: null,
          ledger_hash: null,
          ledger_index: null
        }
        // 1. Determine servers with history in range (if ledger limits)
        // 2. Redirect command to getTransactions if detected @ send
        // 3. Prev/Next methods

        return new Promise((resolve, reject) => {
          let requestObject
          if (typeof CustomOptions === 'object') {
            requestObject = CustomOptions
          } else if (typeof CustomOptions === 'string') {
            try {
              requestObject = JSON.parse(CustomOptions.trim())
            } catch (e) {
              reject(new Error(`Invalid command, could not parse JSON: ${e.message}`))
            }
          } else {
            reject(new Error(`Invalid command: input type: neither object, string`))
          }

          if (typeof requestObject === 'object') {
            Object.keys(Options).forEach(OptionKey => {
              if (typeof requestObject[OptionKey] !== 'undefined') {
                Options[OptionKey] = requestObject[OptionKey]
              }
            })
          }
          Object.keys(Options).forEach(k => {
            if (Options[k] === null) {
              delete Options[k]
            }
          })

          let serverList = []
          let searchStartingAt = null
          if (Options.forward && Options.marker !== null && typeof Options.marker === 'object' && typeof Options.marker.ledger !== 'undefined') {
            searchStartingAt = Options.marker.ledger
          } else if (typeof Options.ledger_index_min !== 'undefined' && Options.ledger_index_min >= 32570) {
            searchStartingAt = Options.ledger_index_min
          }

          if (searchStartingAt !== null) {
            let rankingServers = this.getRanking().source.firstSeqLedger
            Object.keys(rankingServers.values).forEach(r => {
              // console.log(r + ' has ledgers starting at ' + rankingServers.values[r], searchStartingAt)
              if (rankingServers.values[r] < searchStartingAt) {
                serverList.push(r)
                // console.log('   Push ', r)
              }
            })
            if (serverList.length < 1) {
              serverList = rankingServers.order
            } else {
              console.log('Query ServerList ordered health with sequential history starting at ledger_index_min/marker (ledger)', searchStartingAt, serverList)
            }
          } else {
            serverList = this.getRanking().source.firstSeqLedger.order
            console.log('Query ServerList ordered at first available ledger (no marker (ledger)) given', serverList)
          }

          this.send(Options, {
            serverTimeout: 2500,
            overallTimeout: 7500,
            fixedServers: serverList
          }).then(r => {
            let fetchMoreTransactions = null
            if (typeof r.response.marker !== 'undefined' && r.response.marker !== null) {
              fetchMoreTransactions = () => {
                return this.getTransactions(Options.account, Object.assign(requestObject, {
                  marker: r.response.marker
                }))
              }
            }
            resolve({
              server: {
                host: r.server,
                preferenceIndex: r.waterfallSeq
              },
              account: Options.account,
              txCount: typeof r.response.transactions !== 'undefined' ? r.response.transactions.length : 0,
              transactions: typeof r.response.transactions !== 'undefined' && Array.isArray(r.response.transactions) ? r.response.transactions : [],
              more: fetchMoreTransactions,
              replyMs: r.response.__replyMs
            })
          }).catch(e => {
            reject(e)
          })
        })
      },
      send (Command, CustomOptions) {
        /**
         * If a response contains an error of one of these types, do not try again:
         * another server will 100% return the same response. Don't spill load
         */
        const dontRetryErrors = [ 'unknownCmd', 'invalidParams', 'actMalformed', 'lgrIdxsInvalid' ]
        let nonRecoverableError = false
        let responseSent = false

        let Options = {
          idempotency: null,
          serverTimeout: 1000,
          overallTimeout: 5000,
          fixedServers: []
        }
        if (typeof CustomOptions === 'object') {
          Object.keys(Options).forEach(OptionKey => {
            if (typeof CustomOptions[OptionKey] !== 'undefined') {
              Options[OptionKey] = CustomOptions[OptionKey]
            }
          })
        }
        return new Promise((resolve, reject) => {
          let requestObject
          if (typeof Command === 'object') {
            requestObject = Command
          } else if (typeof Command === 'string') {
            try {
              requestObject = JSON.parse(Command.trim())
            } catch (e) {
              reject(new Error(`Invalid command, could not parse JSON: ${e.message}`))
            }
          } else {
            reject(new Error(`Invalid command: input type: neither object, string`))
          }

          if (requestObject) {
            let queryServerId = 0
            let requestsSent = 0
            let failures = []

            /**
             * Query most healthy server, except if account_tx (transactions) command,
             * in that case prefer more history
             */
            let queryServers = this.getRanking().ranking
            if (Array.isArray(Options.fixedServers)) {
              let filteredServers = Options.fixedServers.filter(s => {
                return queryServers.indexOf(s) > -1
              })
              if (filteredServers.length > 0) {
                queryServers = filteredServers
              }
            }
            const callServer = (Server) => {
              console.log('Calling server [' + Server + ']')
              return new Promise((resolve, reject) => {
                // Todo: call rippled connection
                let serverId = queryServers.indexOf(Server)
                requestsSent++
                Connections[queryServers[serverId]].connection.send(requestObject).then(response => {
                  if (typeof response.error !== 'undefined') {
                    if (dontRetryErrors.indexOf(response.error) > -1) {
                      nonRecoverableError = true
                    }
                    // Server actively rejected reply
                    let message = `${response.error_message} #${response.error_code} - ${response.error}`
                    // Recoverable error, maybe another server can resolve
                    reject(new Error(`${Server} reported: ${message}`))
                    failures.push({ server: Server, type: 'soft', error: message })
                  } else {
                    resolve({
                      response: response,
                      server: Server,
                      waterfallSeq: serverId,
                      requestsSent: requestsSent,
                      idempotency: Options.idempotency
                    })
                  }
                }).catch(error => {
                  failures.push({ server: Server, type: 'hard', error: error.message })
                  reject(error)
                })
              })
            }
            const run = () => {
              return new Promise(function (resolve, reject) {
                const callTimeout = isNaN(parseInt(Options.serverTimeout)) ? 1000 : parseInt(Options.serverTimeout)
                let callNextInterval
                const initCallInterval = () => {
                  clearInterval(callNextInterval)
                  callNextInterval = setInterval(callNext, callTimeout)
                  callNext()
                }
                const callNext = () => {
                  callServer(queryServers[queryServerId])
                    .then(r => {
                      clearInterval(callNextInterval)
                      resolve(r)
                    })
                    .catch(e => {
                      console.log('callServerCatch', e)
                      if (nonRecoverableError) {
                        clearInterval(callNextInterval)
                        reject(new Error(`Non Recoverable Error (no retry): ${failures[0].server}: ${failures[0].error} (${failures[0].type})`))
                      } else {
                        if (queryServerId < queryServers.length) {
                          // If not the last: call new server immediately
                          if (!responseSent) {
                            initCallInterval()
                          }
                        } else if (requestsSent === failures.length) {
                          let failureString = failures.map(f => {
                            return `${f.server}: ${f.error} (${f.type})`
                          }).join(', ')
                          reject(new Error(`All servers reported errors: ${failureString}`))
                        }
                      }
                    })

                  queryServerId++
                  if (queryServerId === queryServers.length) {
                    clearInterval(callNextInterval)
                  }
                }
                initCallInterval()
              })
            }

            let overallTimeoutMs = isNaN(parseInt(Options.overallTimeout)) ? 1000 : parseInt(Options.overallTimeout)
            let overallTimeout = setTimeout(() => {
              reject(new Error(`Overall timeout reached after ${overallTimeoutMs} ms`))
            }, overallTimeoutMs)

            run()
              .then(function (response) {
                Object.assign(response, {
                  failures: failures
                })
                // console.log('< Response', response)
                clearTimeout(overallTimeout)
                responseSent = true
                resolve(response)
              })
              .catch(function (error) {
                clearTimeout(overallTimeout)
                responseSent = true
                reject(error)
              })
          }
        })
      },
      getConnection () {
        let servers = this.getRanking().ranking
        if (Array.isArray(servers) && servers.length > 0) {
          return Connections[servers[0]].connection
        } else {
          throw new Error('No connections available')
        }
      },
      getConnections () {
        return Object.values(Connections).map(c => {
          return {
            connection: c.connection,
            hostname: c.hostname,
            state: c.state,
            preference: this.getRanking().ranking.indexOf(c.hostname)
          }
        }).filter(c => {
          return c.preference > -1
        }).sort((a, b) => {
          return a.preference > b.preference
        })
      }
    })
  }
}

module.exports = RippledWsClientPool
