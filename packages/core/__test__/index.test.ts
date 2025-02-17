import { MessageChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createRPC } from '../src'
import * as Alice from './alice'
import * as Bob from './bob'

type BobFunctions = typeof Bob
type AliceFunctions = typeof Alice

function createChannel() {
  const channel = new MessageChannel()
  return {
    channel,
    alice: createRPC<BobFunctions, AliceFunctions>(
      Alice,
      {

        post: data => channel.port2.postMessage(data),
        on: fn => channel.port2.on('message', fn),
      },
    ),
    bob: createRPC<AliceFunctions, BobFunctions>(
      Bob,
      {
        post: data => channel.port1.postMessage(data),
        on: fn => channel.port1.on('message', fn),
      },
    ),
  }
}

it('basic', async () => {
  const { bob, alice } = createChannel()

  // RPCs
  expect(await bob.hello.invoke('Bob'))
    .toEqual('Hello Bob, my name is Alice')
  expect(await alice.hi.invoke('Alice'))
    .toEqual('Hi Alice, I am Bob')

  // one-way event
  expect(alice.bump.send()).toBeUndefined()

  expect(Bob.getCount()).toBe(0)
  await new Promise(resolve => setTimeout(resolve, 1))
  expect(Bob.getCount()).toBe(1)
})

it('async', async () => {
  const { bob, alice } = createChannel()

  await alice
  await bob
})
