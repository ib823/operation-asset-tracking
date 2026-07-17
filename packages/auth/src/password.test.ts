import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

// scrypt at OWASP parameters takes ~400ms per hash, by design. These tests hash a handful of
// times, so the default 5s timeout is not enough.
const TIMEOUT = 30_000

describe('hashPassword', () => {
  it('produces a verifiable hash', { timeout: TIMEOUT }, async () => {
    const hash = await hashPassword('correct horse battery')
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true)
  })

  it('rejects the wrong password', { timeout: TIMEOUT }, async () => {
    const hash = await hashPassword('correct horse battery')
    await expect(verifyPassword('incorrect horse battery', hash)).resolves.toBe(false)
  })

  it('salts — the same password hashes differently every time', { timeout: TIMEOUT }, async () => {
    const [a, b] = await Promise.all([hashPassword('same password 123'), hashPassword('same password 123')])

    // Without a per-hash salt, identical passwords collide and a single rainbow table breaks
    // every account at once.
    expect(a).not.toBe(b)
    await expect(verifyPassword('same password 123', a)).resolves.toBe(true)
    await expect(verifyPassword('same password 123', b)).resolves.toBe(true)
  })

  it('refuses a password under 12 characters', async () => {
    // Enforced in the hasher, so a seed script or admin API cannot bypass form validation.
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/)
  })

  it('records the parameters in the hash, so they can be raised later', { timeout: TIMEOUT }, async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt$131072$8$1$')).toBe(true)
    expect(hash.split('$')).toHaveLength(6)
  })

  it('verifies against the parameters the hash was made with, not the current ones', { timeout: TIMEOUT }, async () => {
    // A hash created with weaker parameters must still verify — otherwise raising N would
    // silently lock out every existing user.
    const hash = await hashPassword('correct horse battery')
    const [, , r, p, salt, key] = hash.split('$')
    const weaker = ['scrypt', 16384, r, p, salt, key].join('$')

    // Deriving with N=16384 against a key made at N=131072 must NOT match...
    await expect(verifyPassword('correct horse battery', weaker)).resolves.toBe(false)
    // ...while the original still does.
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true)
  })
})

describe('verifyPassword', () => {
  it('returns false for a malformed hash rather than throwing', async () => {
    // A corrupt row must fail the login, not surface a 500 that confirms the account exists.
    for (const bad of ['', 'not-a-hash', 'scrypt$only$four$parts', 'bcrypt$1$2$3$4$5', 'scrypt$x$y$z$a$b']) {
      await expect(verifyPassword('anything at all', bad), bad).resolves.toBe(false)
    }
  })

  it('does not accept an empty password against a real hash', { timeout: TIMEOUT }, async () => {
    const hash = await hashPassword('correct horse battery')
    await expect(verifyPassword('', hash)).resolves.toBe(false)
  })
})
