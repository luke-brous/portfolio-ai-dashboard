export default function Login() {
  return (
    // bg-slate-50 is a tinted blue-white, avoiding pure #FFF
    // text-slate-900 is a deep midnight blue-gray, avoiding pure #000
    <div className="min-h-screen bg-slate-50 text-slate-900 font-['Outfit'] selection:bg-indigo-100 selection:text-indigo-900">
      {/* Navbar */}
      <nav className="w-full py-6 px-8 md:px-16 flex justify-between items-center border-b border-slate-200">
        <div className="text-xl font-bold tracking-tight text-indigo-950">
          Mail Brief
        </div>
        <div className="flex gap-8 text-sm font-medium text-slate-600">
          {/* Smooth color transitions, no bounces */}
          <a
            href="#"
            className="hover:text-indigo-600 transition-colors duration-300 ease-in-out"
          >
            How it Works
          </a>
          <a
            href="#"
            className="hover:text-indigo-600 transition-colors duration-300 ease-in-out"
          >
            Privacy
          </a>
        </div>
      </nav>

      {/* Main Content - No Cards, just organic layout */}
      <main className="flex flex-col justify-center items-start max-w-3xl mx-auto px-8 md:px-16 pt-32 pb-16">
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-indigo-950 mb-6 leading-tight">
          Tame your inbox <br className="hidden md:block" /> with AI.
        </h1>

        <p className="text-lg md:text-xl text-slate-600 mb-12 max-w-lg leading-relaxed font-light">
          Connect your Google account and let Gemini summarize your labeled
          threads in seconds. No clutter, just the brief.
        </p>

        <button
          onClick={() => (window.location.href = "/auth/login")}
          className="group relative inline-flex items-center justify-center px-8 py-4 bg-indigo-600 text-white font-medium text-lg rounded-full overflow-hidden transition-all duration-300 ease-in-out hover:bg-indigo-700 hover:shadow-[0_0_20px_rgba(79,70,229,0.25)] hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-50"
        >
          <span>Connect Gmail</span>
          {/* Arrow animates smoothly to the right on hover */}
          <svg
            className="ml-3 w-5 h-5 transition-transform duration-300 ease-in-out group-hover:translate-x-1"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M14 5l7 7m0 0l-7 7m7-7H3"
            />
          </svg>
        </button>
      </main>
    </div>
  );
}
