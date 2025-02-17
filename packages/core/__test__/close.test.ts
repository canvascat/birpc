import { nextTick } from 'node:process'
import { expect, it } from 'vitest'
import { createRPC } from '../src'

it('stops the rpc promises', async () => {
  expect.assertions(2)
  const rpc = createRPC<{ hello: () => string }>({}, {
    on() {},
    post() {},
  })
  const promise = rpc.hello.invoke().then(
    () => {
      throw new Error('Promise should not resolve')
    },
    (err) => {
      // Promise should reject
      expect(err.message).toBe('[birpc] rpc is closed, cannot call "hello"')
    },
  )
  nextTick(() => {
    rpc.$close()
  })
  await promise
  await expect(() => rpc.hello.invoke()).rejects.toThrow('[birpc] rpc is closed, cannot call "hello"')
})
