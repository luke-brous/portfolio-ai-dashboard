import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    // Matches the Login/Dashboard chrome verbatim
    <div className="min-h-screen bg-slate-50 text-slate-900 font-['Outfit'] selection:bg-indigo-100 selection:text-indigo-900">
      {/* Navbar — mirrors Login.tsx (static, not sticky) */}
      <nav className="w-full py-6 px-8 md:px-16 flex justify-between items-center border-b border-slate-200">
        <div className="text-xl font-bold tracking-tight text-indigo-950">
          Mail Brief
        </div>
        <div className="flex gap-8 text-sm font-medium text-slate-600">
          <Link
            to="/"
            className="hover:text-indigo-600 transition-colors duration-300 ease-in-out"
          >
            Home
          </Link>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex flex-col justify-center items-start max-w-3xl mx-auto px-8 md:px-16 pt-32 pb-16">
        <h1 className="text-7xl md:text-9xl font-bold tracking-tight text-indigo-950 mb-6 leading-none">
          404
        </h1>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-indigo-950 mb-6">
          Page not found.
        </h2>
        <p className="text-lg md:text-xl text-slate-600 mb-12 max-w-lg leading-relaxed font-light">
          The URL you followed may be broken, or the page may have been moved.
        </p>

        <Link
          to="/"
          className="group relative inline-flex items-center justify-center px-8 py-4 bg-indigo-600 text-white font-medium text-lg rounded-full overflow-hidden transition-all duration-300 ease-in-out hover:bg-indigo-700 hover:shadow-[0_0_20px_rgba(79,70,229,0.25)] hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-50"
        >
          {/* Arrow now points LEFT to signal "return" */}
          <svg
            className="mr-3 w-5 h-5 transition-transform duration-300 ease-in-out group-hover:-translate-x-1"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          <span>Return Home</span>
        </Link>
      </main>
    </div>
  );
}
