import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing: scrypt, from the Node standard library (ADR-0011).
 *
 * scrypt is memory-hard and is an OWASP-listed password KDF. We reached for Argon2id first —
 * it is OWASP's *preferred* choice — but every Argon2 binding for Node ships a native
 * `.node` binary, and that turned out to be a poor fit here:
 *
 *   - webpack cannot parse a native binary, so any route importing it fails the build;
 *   - Next's `serverExternalPackages` does not help, because the module actually resolved is
 *     the platform-specific subpackage (`@node-rs/argon2-linux-x64-gnu`) whose NAME varies by
 *     architecture — pinning it would break the arm64/x64 Docker builds this is handed over as;
 *   - it cannot be reached from the Edge runtime at all.
 *
 * scrypt has none of those problems: zero dependencies, no binary, works in any Node runtime.
 * The brief's "prefer the standard library, keep dependencies minimal" points the same way,
 * and a dependency we do not have is a dependency the client never has to patch.
 *
 * Parameters are OWASP's strongest listed scrypt profile: N=2^17 (128 MiB), r=8, p=1.
 * ~400ms per hash on the dev container. That cost is paid only at sign-in — never on a
 * request — and being slow is the entire point of a password KDF.
 */
// promisify picks scrypt's 3-argument overload, which drops the options we need to pass.
// Annotate the 4-argument form explicitly.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

const PARAMS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  // N * r * 128 is ~134 MiB; the default maxmem (32 MiB) would reject it outright.
  maxmem: 256 * 1024 * 1024,
} as const

const MIN_PASSWORD_LENGTH = 12

/** `scrypt$N$r$p$salt$key`, all base64. Self-describing, so parameters can be raised later
 *  without invalidating existing hashes — an old hash still carries the N it was made with. */
function encode(salt: Buffer, key: Buffer): string {
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

interface Decoded {
  N: number
  r: number
  p: number
  salt: Buffer
  key: Buffer
}

function decode(hash: string): Decoded | null {
  const parts = hash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null

  return { N, r, p, salt: Buffer.from(parts[4]!, 'base64'), key: Buffer.from(parts[5]!, 'base64') }
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    // Enforced here, not only at the form, so that no code path can create a weak credential
    // — a seed script or an admin API would otherwise bypass UI validation entirely.
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }

  const salt = randomBytes(PARAMS.saltLength)
  const key = await scrypt(plaintext, salt, PARAMS.keyLength, PARAMS)

  return encode(salt, key)
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row should fail the
 * login, not surface a 500 that confirms to an attacker that the account exists.
 */
export async function verifyPassword(plaintext: string, hashed: string): Promise<boolean> {
  const decoded = decode(hashed)
  if (!decoded) return false

  try {
    // Derive with the parameters the hash was CREATED with, not today's — otherwise raising
    // N would silently lock out every existing user.
    const key = await scrypt(plaintext, decoded.salt, decoded.key.length, {
      N: decoded.N,
      r: decoded.r,
      p: decoded.p,
      maxmem: PARAMS.maxmem,
    })

    // Constant-time: a byte-by-byte `equals` leaks how much of the hash matched.
    return key.length === decoded.key.length && timingSafeEqual(key, decoded.key)
  } catch {
    return false
  }
}

/**
 * Spend the same time a real verify would, to keep the no-such-user path indistinguishable.
 *
 * Without this, a login for a non-existent account returns in ~0ms while a real one takes
 * ~400ms of scrypt — a reliable oracle for enumerating valid accounts, and a free head start
 * on building a phishing list.
 */
export async function burnTime(): Promise<void> {
  await verifyPassword('timing-equaliser', encode(randomBytes(PARAMS.saltLength), randomBytes(PARAMS.keyLength)))
}
