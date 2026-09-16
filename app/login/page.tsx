import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function LoginPage() {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="font-serif text-2xl">Flow</h1>
        <p className="text-sm text-muted">Log in with the account your admin gave you.</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
