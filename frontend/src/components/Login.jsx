import React, { useState } from "react";
import { loginUser, registerUser } from "../api/authApi";
import { storeAuthSession } from "../utils/storage";
import "./Login.css";

export default function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isRegister) {
        await registerUser(username, password);
        // Login immediately after register
      }
      const data = await loginUser(username, password);
      storeAuthSession(data.access_token, data.expires_in);
      onLogin(data.access_token);
    } catch (err) {
      setError(err.response?.data?.detail || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="bg-surface-container-lowest p-10 rounded-2xl shadow-[0px_12px_32px_rgba(0,21,42,0.06)] max-w-md w-full border border-surface-container-high relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
          <span className="material-symbols-outlined text-8xl">lock</span>
        </div>
        
        <div className="relative z-10">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-surface-container-low rounded-2xl flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-4xl" style={{fontVariationSettings: "'FILL' 1"}}>admin_panel_settings</span>
            </div>
          </div>
          
          <h2 className="text-2xl font-extrabold tracking-tighter text-primary text-center headline mb-2">
            {isRegister ? "Secure Registration" : "Sanctuary Access"}
          </h2>
          <p className="text-center text-sm text-on-surface-variant font-body mb-8">
            {isRegister ? "Create a verified institutional account." : "Authenticate your credentials to proceed."}
          </p>
          
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="p-3 bg-error-container text-error rounded-lg text-sm font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">error</span>
                {error}
              </div>
            )}
            
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Institutional ID</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">person</span>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your credential"
                  className="w-full bg-surface-container-highest border-none rounded-lg py-3 pl-10 pr-4 text-sm font-body focus:ring-2 focus:ring-primary/20 transition-all"
                />
              </div>
            </div>
            
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Passphrase</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">key</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your passphrase"
                  className="w-full bg-surface-container-highest border-none rounded-lg py-3 pl-10 pr-4 text-sm font-body focus:ring-2 focus:ring-primary/20 transition-all"
                />
              </div>
            </div>
            
            <button 
              type="submit" 
              disabled={loading} 
              className="w-full mt-6 py-3 bg-primary text-on-primary rounded-lg font-bold text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all flex justify-center items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                  Validating...
                </>
              ) : isRegister ? (
                <>
                  <span className="material-symbols-outlined text-sm">person_add</span> Initialize Profile
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">login</span> Authenticate
                </>
              )}
            </button>
          </form>
          
          <p className="text-center mt-8 text-xs font-semibold text-on-surface-variant">
            {isRegister ? "Already hold credentials?" : "No institutional access?"}{" "}
            <button 
              className="text-primary hover:text-tertiary-container hover:underline ml-1 font-bold"
              onClick={() => setIsRegister(!isRegister)}
            >
              {isRegister ? "Login here" : "Request access"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
