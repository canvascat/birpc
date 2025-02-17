import { MessageChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createRPC } from '../src'
import * as Alice from './alice'
import * as Bob from './bob'

type BobFunctions = typeof Bob
type AliceFunctions = typeof Alice

it('dynamic', async () => {
  const channel = new MessageChannel()

  const bob = createRPC<AliceFunctions, BobFunctions>(
    { ...Bob },
    {
      post: data => channel.port1.postMessage(data),
      on: fn => channel.port1.on('message', fn),
    },
  )

  const alice = createRPC<BobFunctions, AliceFunctions>(
    { ...Alice },
    {
      post: data => channel.port2.postMessage(data),
      on: fn => channel.port2.on('message', fn),
    },
  )

  // RPCs
  expect(await bob.hello.invoke('Bob'))
    .toEqual('Hello Bob, my name is Alice')
  expect(await alice.hi.invoke('Alice'))
    .toEqual('Hi Alice, I am Bob')

  expect(await bob.hello.invoke('Bob'))
    .toEqual('Alice says hello to Bob')

  // Adding new functions
  // @ts-expect-error `foo` is not defined
  alice.$functions.foo = async (name: string) => {
    return `A random function, called by ${name}`
  }

  // @ts-expect-error `foo` is not defined
  expect(await bob.foo.invoke('Bob'))
    .toEqual('A random function, called by Bob')
})
