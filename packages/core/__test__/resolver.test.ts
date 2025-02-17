import { MessageChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createRPC } from '../src'
import * as Alice from './alice'
import * as Bob from './bob'

type BobFunctions = typeof Bob
type AliceFunctions = typeof Alice

it('resolver', async () => {
  const channel = new MessageChannel()

  const bob = createRPC<AliceFunctions, BobFunctions>(
    { ...Bob },
    {
      post: data => channel.port1.postMessage(data),
      on: fn => channel.port1.on('message', fn),
    },
  )

  let customResolverFn: ((...args: any[]) => any) | undefined

  const alice = createRPC<BobFunctions, AliceFunctions>(
    { ...Alice },
    {
      post: data => channel.port2.postMessage(data),
      on: fn => channel.port2.on('message', fn),
      resolver: (name, fn) => {
        if (name === 'foo')
          return customResolverFn
        return fn
      },
    },
  )

  // RPCs
  expect(await bob.hello.invoke('Bob'))
    .toEqual('Hello Bob, my name is Alice')
  expect(await alice.hi.invoke('Alice'))
    .toEqual('Hi Alice, I am Bob')

  // @ts-expect-error `foo` is not defined
  await expect(bob.foo.invoke('Bob'))
    .rejects
    .toThrow('[birpc] function "foo" not found')

  customResolverFn = (a: string) => `Custom resolve function to ${a}`

  // @ts-expect-error `foo` is not defined
  expect(await bob.foo.invoke('Bob'))
    .toBe('Custom resolve function to Bob')
})
