import { redirect } from 'next/navigation'
import { auth, signIn } from '@/lib/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string }>
}) {
  const session = await auth()
  if (session?.user) redirect('/')

  const params = await searchParams

  async function authenticate(formData: FormData) {
    'use server'
    const from = formData.get('from')
    try {
      await signIn('credentials', {
        email: String(formData.get('email') ?? ''),
        password: String(formData.get('password') ?? ''),
        redirectTo: typeof from === 'string' && from.startsWith('/') ? from : '/',
      })
    } catch (error) {
      // next-auth signals a successful redirect by throwing; rethrow so Next handles it.
      if (error instanceof Error && error.message === 'NEXT_REDIRECT') throw error
      redirect('/signin?error=1')
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Lablink Operational Asset Tracker</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={authenticate} className="space-y-4">
            {params.from ? <input type="hidden" name="from" value={params.from} /> : null}

            {params.error ? (
              // One message for every failure. Distinguishing "no such user" from "wrong
              // password" hands an attacker a free user-enumeration oracle.
              <p
                role="alert"
                data-testid="signin-error"
                className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Incorrect email or password.
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            <button
              type="submit"
              className="h-9 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground"
            >
              Sign in
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
