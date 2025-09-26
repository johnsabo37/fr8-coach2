// pages/login.tsx (Pages Router)

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/_site-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const params = new URLSearchParams(window.location.search);
        const next = params.get("next") || "/";
        window.location.href = next;
      } else {
        setError("Invalid password.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
  };

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form onSubmit={submit} style={{ maxWidth: 360, width: "100%" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Enter Site Password</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          style={{ width: "100%", padding: 10, border: "1px solid #ccc", borderRadius: 6 }}
        />
        {error && <p style={{ color: "#b00020", fontSize: 14, marginTop: 8 }}>{error}</p>}
        <button type="submit" style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, background: "#111", color: "#fff" }}>
          Unlock
        </button>
      </form>
    </main>
  );
}
