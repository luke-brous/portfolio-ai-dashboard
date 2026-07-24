import { NavLink } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

const tabs = [
  { to: "/landing/mailbrief", label: "Mailbrief" },
  { to: "/landing/advisor", label: "Advisor" },
  { to: "/landing/crm", label: "CRM" },
];

export default function Navbar() {
  const queryClient = useQueryClient();

  const handleLogout = () => {
    // Nuke the cached data that is still there before redirecting
    queryClient.clear();
    const backendURL = import.meta.env.VITE_BACKEND_URL;
    window.location.replace(`${backendURL}/auth/logout`);
  };

  return (
    <nav className="sticky top-0 z-10 w-full border-b border-slate-200 bg-slate-50/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-8 py-6 md:px-16 flex items-center justify-between">
        {/* Brand */}
        <NavLink
          to="/landing"
          className="text-xl font-bold tracking-tight text-indigo-950 transition-opacity duration-300 ease-in-out hover:opacity-70"
        >
          Mail Brief
        </NavLink>

        {/* Tabs */}
        <div className="flex items-center gap-1 sm:gap-2">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }: { isActive: boolean }) =>
                `relative px-3 py-2 text-sm font-medium rounded-md transition-colors duration-300 ease-in-out ${
                  isActive
                    ? "text-indigo-700 bg-indigo-50"
                    : "text-slate-600 hover:text-indigo-600 hover:bg-slate-100/60"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
          <button
            onClick={handleLogout}
            className="ml-2 px-3 py-2 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors duration-300 ease-in-out"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
