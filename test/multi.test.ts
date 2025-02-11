import { MessageChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createBirpc } from '../src'
import * as Alice from './alice'
import * as Multi from './multi'

it('multi', async () => {
  const channel = new MessageChannel()

  const alice = createBirpc<typeof Alice, typeof Multi>(
    { ...Multi },
    {
      post: data => channel.port1.postMessage(data),
      on: fn => channel.port1.on('message', fn),
    },
  )

  const multi = createBirpc<typeof Multi, typeof Alice>(
    { ...Alice },
    {
      // mark bob's `bump` as an event without response
      // eventNames: ['bump'],
      post: data => channel.port2.postMessage(data),
      on: fn => channel.port2.on('message', fn),
    },
  )

  // RPCs
  expect(await alice.hello('Bob'))
    .toEqual('Hello Bob, my name is Alice')
  expect(await multi.bob.hi('Alice'))
    .toEqual('Hi Alice, I am Bob')

  // replace Alice's `hello` function
  multi.$functions.hello = (name: string) => {
    return `Alice says hello to ${name}`
  }

  expect(await alice.hello('Bob'))
    .toEqual('Alice says hello to Bob')

  // Adding new functions
  // @ts-expect-error `foo` is not defined
  multi.$functions.foo = async (name: string) => {
    return `A random function, called by ${name}`
  }

  // @ts-expect-error `foo` is not defined
  expect(await alice.foo('Bob'))
    .toEqual('A random function, called by Bob')
})
