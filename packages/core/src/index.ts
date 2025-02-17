import {
  createFlatProxy,
  createRecursiveProxy,
} from './createProxy'

type ArgumentsType<T> = T extends (...args: infer A) => any ? A : never
type ReturnType<T> = T extends (...args: any) => infer R ? R : never
type PromisifyFn<T> = ReturnType<T> extends Promise<any>
  ? T
  : (...args: ArgumentsType<T>) => Promise<Awaited<ReturnType<T>>>

type RPCResolver = (name: string, resolved: (...args: unknown[]) => unknown) => ((...args: unknown[]) => unknown) | undefined

interface ChannelOptions {
  /**
   * Function to post raw message
   */
  post: (data: any, ...extras: any[]) => any | Promise<any>
  /**
   * Listener to receive raw message
   */
  on: (fn: (data: any, ...extras: any[]) => void) => any | Promise<any>
  /**
   * Clear the listener when `$close` is called
   */
  off?: (fn: (data: any, ...extras: any[]) => void) => any | Promise<any>
  /**
   * Custom function to serialize data
   *
   * by default it passes the data as-is
   */
  serialize?: (data: any) => any
  /**
   * Custom function to deserialize data
   *
   * by default it passes the data as-is
   */
  deserialize?: (data: any) => any

}

type AnyFn = (...args: any[]) => any

interface EventOptions {

  /**
   * Maximum timeout for waiting for response, in milliseconds.
   *
   * @default 60_000
   */
  timeout?: number

  /**
   * Custom resolver to resolve function to be called
   *
   * For advanced use cases only
   */
  resolver?: RPCResolver

  /**
   * Custom error handler for errors occurred in local functions being called
   *
   * @returns `true` to prevent the error from being thrown
   */
  onFunctionError?: (error: Error, functionName: string, args: any[]) => boolean | void

  /**
   * Custom error handler for errors occurred during serialization or messsaging
   *
   * @returns `true` to prevent the error from being thrown
   */
  onGeneralError?: (error: Error, functionName?: string, args?: any[]) => boolean | void

  /**
   * Custom error handler for timeouts
   *
   * @returns `true` to prevent the error from being thrown
   */
  onTimeoutError?: (functionName: string, args: any[]) => boolean | void
}

export type RPCOptions = EventOptions & ChannelOptions

interface RPCFn<T> {
  invoke: PromisifyFn<T>
  send: (...args: ArgumentsType<T>) => void
}

type RPCFunctions<T> = T extends ((...args: any[]) => any) ? Readonly<RPCFn<T>> : Readonly<{
  [K in keyof T]: RPCFunctions<T[K]>
}>

type RPCReturn<RemoteFunctions> = RPCFunctions<RemoteFunctions> & Readonly<{ $close: () => void }>

enum RPC_MESSAGE_TYPE {
  REQUEST, // = 'q',
  RESPONSE, // = 's',
}

interface Request {
  /**
   * Type
   */
  t: RPC_MESSAGE_TYPE.REQUEST
  /**
   * ID
   */
  i?: string
  /**
   * Method
   */
  m: string
  /**
   * Arguments
   */
  a: any[]
}

interface Response {
  /**
   * Type
   */
  t: RPC_MESSAGE_TYPE.RESPONSE
  /**
   * Id
   */
  i: string
  /**
   * Result
   */
  r?: any
  /**
   * Error
   */
  e?: any
}

type RPCMessage = Request | Response

const DEFAULT_TIMEOUT = 60_000 // 1 minute

function defaultSerialize(i: any) {
  return i
}
const defaultDeserialize = defaultSerialize

// Store public APIs locally in case they are overridden later
const { clearTimeout, setTimeout } = globalThis
const random = Math.random.bind(Math)

export function createRPC<RemoteFunctions = Record<string, never>, LocalFunctions extends object = Record<string, never>>(
  functions: LocalFunctions,
  options: RPCOptions,
): RPCReturn<RemoteFunctions> {
  const {
    post,
    on,
    off = () => {},

    serialize = defaultSerialize,
    deserialize = defaultDeserialize,
    resolver,
    timeout = DEFAULT_TIMEOUT,
  } = options

  const rpcPromiseMap = new Map<string, {
    resolve: (arg: any) => void
    reject: (error: any) => void
    method: string
    timeoutId?: ReturnType<typeof setTimeout>
  }>()

  let _promise: Promise<any> | any
  let closed = false

  const createCall = (method: keyof RPCFn<AnyFn>, fullPath: string) => {
    const sendEvent = (...args: any[]) => {
      post(serialize(<Request>{ m: fullPath, a: args, t: RPC_MESSAGE_TYPE.REQUEST }))
    }
    if (method === 'send') {
      return sendEvent
    }

    const sendCall = async (...args: any[]) => {
      if (closed)
        throw new Error(`[birpc] rpc is closed, cannot call "${fullPath}"`)
      if (_promise) {
        // Wait if `on` is promise
        try {
          await _promise
        }
        finally {
          // don't keep resolved promise hanging
          _promise = undefined
        }
      }
      return new Promise((resolve, reject) => {
        const id = nanoid()
        let timeoutId: ReturnType<typeof setTimeout> | undefined

        if (timeout >= 0) {
          timeoutId = setTimeout(() => {
            try {
              // Custom onTimeoutError handler can throw its own error too
              const handleResult = options.onTimeoutError?.(fullPath, args)
              if (handleResult !== true)
                throw new Error(`[birpc] timeout on calling "${fullPath}"`)
            }
            catch (e) {
              reject(e)
            }
            rpcPromiseMap.delete(id)
          }, timeout)

          // For node.js, `unref` is not available in browser-like environments
          if (typeof timeoutId === 'object')
            timeoutId = timeoutId.unref?.()
        }

        rpcPromiseMap.set(id, { resolve, reject, timeoutId, method: fullPath })
        post(serialize(<Request>{ m: fullPath, a: args, i: id, t: RPC_MESSAGE_TYPE.REQUEST }))
      })
    }
    return sendCall
  }
  const proxy = createRecursiveProxy<RPCFunctions<RemoteFunctions>>(
    ({ path, args }) => {
      const pathCopy = [...path]
      const method = pathCopy.pop()! as keyof RPCFn<AnyFn>

      const fullPath = pathCopy.join('.')

      return createCall(method, fullPath)(...args)
    },
  )

  const rpc = createFlatProxy<RPCReturn<RemoteFunctions>>((method) => {
    if (method === '$close')
      return close

    // catch if "createBirpc" is returned from async function
    if (method === 'then' && !('then' in functions))
      return undefined
    return proxy[method]
  })

  function close() {
    closed = true
    rpcPromiseMap.forEach(({ reject, method }) => {
      reject(new Error(`[birpc] rpc is closed, cannot call "${method}"`))
    })
    rpcPromiseMap.clear()
    off(onMessage)
  }

  async function onMessage(data: any, ...extra: any[]) {
    let msg: RPCMessage

    try {
      msg = deserialize(data) as RPCMessage
    }
    catch (e) {
      if (options.onGeneralError?.(e as Error) !== true)
        throw e
      return
    }

    if (msg.t === RPC_MESSAGE_TYPE.REQUEST) {
      const { m: method, a: args } = msg
      let result, error: any

      let fn: any = getFnByPath(method, functions)
      if (resolver)
        fn = resolver(method, fn)

      if (!fn) {
        error = new Error(`[birpc] function "${method}" not found`)
      }
      else {
        try {
          result = await fn.apply(rpc, args)
        }
        catch (e) {
          error = e
        }
      }

      if (msg.i) {
        // Error handling

        if (error && options.onFunctionError) {
          if (options.onFunctionError(error, method, args) === true)
            return
        }

        // Send data
        if (!error) {
          try {
            post(serialize(<Response>{ t: RPC_MESSAGE_TYPE.RESPONSE, i: msg.i, r: result }), ...extra)
            return
          }
          catch (e) {
            error = e
            if (options.onGeneralError?.(e as Error, method, args) !== true)
              throw e
          }
        }
        // Try to send error if serialization failed
        try {
          post(serialize(<Response>{ t: RPC_MESSAGE_TYPE.RESPONSE, i: msg.i, e: error }), ...extra)
        }
        catch (e) {
          if (options.onGeneralError?.(e as Error, method, args) !== true)
            throw e
        }
      }
    }
    else {
      const { i: ack, r: result, e: error } = msg
      const promise = rpcPromiseMap.get(ack)
      if (promise) {
        clearTimeout(promise.timeoutId)

        if (error)
          promise.reject(error)
        else
          promise.resolve(result)
      }
      rpcPromiseMap.delete(ack)
    }
  }

  _promise = on(onMessage)

  return rpc
}

const cacheMap = new WeakMap<any, any>()
export function cachedMap<T, R>(items: T[], fn: ((i: T) => R)): R[] {
  return items.map((i) => {
    let r = cacheMap.get(i)
    if (!r) {
      r = fn(i)
      cacheMap.set(i, r)
    }
    return r
  })
}

// port from nanoid
// https://github.com/ai/nanoid
const urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
function nanoid(size = 21) {
  let id = ''
  let i = size
  while (i--)
    id += urlAlphabet[(random() * 64) | 0]
  return id
}

function getFnByPath(
  path: string,
  functions: any,
) {
  let fn: ((...args: any) => any) | null = null

  while (!fn) {
    const key = Object.keys(functions).find(key => path.startsWith(key))
    if (!key)
      return null
    functions = functions[key]
    if (key === path && typeof functions === 'function')
      fn = functions
    path = path.slice(key.length + 1)
  }

  return fn
}
