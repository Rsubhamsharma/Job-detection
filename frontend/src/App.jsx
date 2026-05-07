import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  BarChart2, Shield, Activity, Lock, Users, User,
  Zap, ArrowRight, CheckCircle, Clock, Search,
  Menu, X, LayoutDashboard, Settings, LogOut,
  Mail, Globe, Sparkles, TrendingUp, Sun, Moon,
  Eye, EyeOff, Linkedin, Check, AlertCircle, Loader2
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import './index.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const MotionDiv = motion.div
const LOCAL_USERS_KEY = 'jobzoid-local-users'
const SESSION_USER_KEY = 'jobzoid-session-user'
const LAST_AUTH_EMAIL_KEY = 'jobzoid-last-auth-email'

const getLocalUsers = () => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '{}')
  } catch {
    return {}
  }
}

const saveLocalUser = (user) => {
  const users = getLocalUsers()
  users[user.email] = user
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users))
}

const getStoredSessionUser = () => {
  try {
    const sessionUser = JSON.parse(localStorage.getItem(SESSION_USER_KEY) || 'null')
    if (sessionUser) {
      return sessionUser
    }

    const lastAuthEmail = localStorage.getItem(LAST_AUTH_EMAIL_KEY)
    if (!lastAuthEmail) {
      return null
    }

    const localUser = getLocalUsers()[lastAuthEmail]
    if (!localUser) {
      return null
    }

    return {
      ...localUser,
      avatar: localUser.avatar || `https://i.pravatar.cc/150?u=${localUser.email}`,
    }
  } catch {
    return null
  }
}

const saveSessionUser = (user) => {
  localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user))
  if (user?.email) {
    localStorage.setItem(LAST_AUTH_EMAIL_KEY, user.email)
  }
}

const clearSessionUser = () => {
  localStorage.removeItem(SESSION_USER_KEY)
}

const getAuthHeaders = (token) => (
  token ? { Authorization: `Bearer ${token}` } : {}
)

const formatTimestamp = (value) => {
  if (!value) return 'Not updated yet'
  const numeric = Number(value)
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
    : new Date(value)
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2020) return 'Not updated yet'
  return date.toLocaleString()
}

const formatScore = (job) => {
  if (job?.scoreStatus === 'not_enough_effort_data' || job?.scoreStatus === 'not_enough_data') {
    return 'Not enough effort data'
  }
  if (job?.energySinkScore !== null && job?.energySinkScore !== undefined) {
    return Math.round(job.energySinkScore)
  }
  return '--'
}

const formatEffortResponse = (job) => {
  const effort = Math.round(job?.effortScore ?? 0)
  const response = Math.round(job?.responseScore ?? 0)
  if (job?.scoreStatus !== 'scored' && effort === 0) {
    return 'Not enough effort data'
  }
  return `Effort ${effort} | ${formatResponseStatus(job)}`
}

const formatResponseStatus = (job) => ({
  acknowledged: 'Response acknowledged',
  application_acknowledged: 'Response acknowledged',
  interview: 'Interview detected',
  interview_detected: 'Interview detected',
  rejection: 'Rejected',
  rejection_detected: 'Rejected',
  rejected: 'Rejected',
  offer: 'Offer detected',
  offer_detected: 'Offer detected',
  no_response: 'No response',
  no_response_after_delay: 'No response',
  pending: 'Response pending',
}[job?.responseStatus || 'pending'] || 'Response pending')

const formatRecommendation = (job) => {
  const scoreStatus = job?.scoreStatus || 'not_enough_effort_data'
  const energySinkScore = job?.energySinkScore
  
  // PHASE 9 rules
  if (scoreStatus === 'not_enough_effort_data' || scoreStatus === 'not_enough_data') {
    return 'Tracking'
  }
  if (energySinkScore === null || energySinkScore === undefined) {
    return 'Tracking'
  }
  if (scoreStatus === 'scored') {
    if (energySinkScore >= 70) {
      return 'Avoid'
    } else if (energySinkScore >= 40) {
      return 'Apply cautiously'
    } else {
      return 'Apply confidently'
    }
  }
  return 'Tracking'
}

const getRecommendationClass = (job) => {
  if (job?.scoreStatus === 'tracking_response_pending' || job?.scoreStatus === 'response_pending') return 'bg-amber-100 text-amber-600'
  if (job?.scoreStatus !== 'scored') return 'bg-slate-100 text-slate-600'
  if (job.recommendation === 'Avoid') return 'bg-rose-100 text-rose-600'
  if (job.recommendation === 'Apply cautiously') return 'bg-amber-100 text-amber-600'
  return 'bg-emerald-100 text-emerald-600'
}

const getScoreDotClass = (job) => {
  if (job?.scoreStatus === 'not_enough_effort_data' || job?.scoreStatus === 'not_enough_data') return 'bg-slate-400'
  if (job.energySinkScore >= 70) return 'bg-rose-500'
  if (job.energySinkScore >= 40) return 'bg-amber-500'
  return 'bg-emerald-500'
}

const buildAnalyticsFromJobs = (jobs = [], signalCount = 0, lastUpdated = null) => {
  const validJobs = jobs.filter(job => job?.jobId && (job.effortScore > 0 || String(job.jobId).startsWith('linkedin:')))
  const numericJobs = validJobs.filter(job => typeof job.energySinkScore === 'number')
  const responded = validJobs.filter(job => !['pending', '', null, undefined].includes(job.responseStatus))
  const totalApplications = validJobs.length
  const averageEnergyScore = numericJobs.length
    ? Math.round((numericJobs.reduce((sum, job) => sum + job.energySinkScore, 0) / numericJobs.length) * 10) / 10
    : 0
  const averageResponseRate = totalApplications ? Math.round((responded.length / totalApplications) * 100) : 0
  const grouped = numericJobs.reduce((acc, job) => {
    const companyName = job.companyName || job.company || 'Unknown'
    acc[companyName] = acc[companyName] || []
    acc[companyName].push(job)
    return acc
  }, {})
  const ranked = Object.entries(grouped).map(([companyName, rows]) => ({
    companyName,
    jobTitle: rows[0]?.jobTitle,
    energySinkScore: Math.round((rows.reduce((sum, job) => sum + job.energySinkScore, 0) / rows.length) * 10) / 10,
    applicationCount: rows.length,
  })).sort((a, b) => b.energySinkScore - a.energySinkScore)
  return {
    totalApplications,
    averageResponseRate,
    averageEnergyScore,
    topRiskyCompanies: ranked.slice(0, 5),
    bestCompanies: [...ranked].reverse().slice(0, 5),
    signalCount,
    lastUpdated,
    summary: {
      averageEffort: totalApplications ? Math.round((validJobs.reduce((sum, job) => sum + (job.effortScore || 0), 0) / totalApplications) * 10) / 10 : 0,
      responseCount: responded.length,
      pendingResponseCount: Math.max(totalApplications - responded.length, 0),
    },
  }
}

// --- COMPONENTS ---

const Nav = ({ user, activeTab, setActiveTab, onSignOut, theme, toggleTheme }) => (
  <nav className="fixed top-0 left-0 right-0 h-16 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 z-50 px-6 flex items-center justify-between transition-colors duration-300">
    <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab(user ? 'dashboard' : 'home')}>
      <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold italic">JZ</div>
      <span className="font-extrabold text-xl tracking-tight text-slate-900 dark:text-white">JobZoid</span>
    </div>
    
    <div className="hidden md:flex items-center gap-8">
      {user ? (
        <>
          <button onClick={() => setActiveTab('dashboard')} className={`text-sm font-semibold transition-colors ${activeTab === 'dashboard' ? 'text-indigo-600' : 'text-slate-600 dark:text-slate-400 hover:text-indigo-600'}`}>Dashboard</button>
          <button onClick={() => setActiveTab('analytics')} className={`text-sm font-semibold transition-colors ${activeTab === 'analytics' ? 'text-indigo-600' : 'text-slate-600 dark:text-slate-400 hover:text-indigo-600'}`}>Analytics</button>
        </>
      ) : (
        <>
          <button onClick={() => setActiveTab('home')} className={`text-sm font-semibold transition-colors ${activeTab === 'home' ? 'text-indigo-600' : 'text-slate-600 dark:text-slate-400 hover:text-indigo-600'}`}>Home</button>
          <button onClick={() => setActiveTab('how-it-works')} className={`text-sm font-semibold transition-colors ${activeTab === 'how-it-works' ? 'text-indigo-600' : 'text-slate-600 dark:text-slate-400 hover:text-indigo-600'}`}>How It Works</button>
          <button onClick={() => setActiveTab('about')} className={`text-sm font-semibold transition-colors ${activeTab === 'about' ? 'text-indigo-600' : 'text-slate-600 dark:text-slate-400 hover:text-indigo-600'}`}>About</button>
        </>
      )}
    </div>

    <div className="flex items-center gap-4">
      <button 
        onClick={toggleTheme}
        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-600 dark:text-slate-400 transition-colors"
        title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>

      {user ? (
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end hidden sm:flex">
            <span className="text-sm font-bold text-slate-900 dark:text-white leading-none">{user.name}</span>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{user.role}</span>
          </div>
          {user.avatar && <img src={user.avatar} className="w-8 h-8 rounded-full ring-2 ring-slate-100 dark:ring-slate-800" alt="avatar" />}
          <button onClick={onSignOut} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-600 dark:text-slate-400 transition-colors"><LogOut size={20} /></button>
        </div>
      ) : (
        <div className="flex items-center gap-6">
          <button className="text-sm font-bold text-slate-600 dark:text-slate-400 hover:text-indigo-600 transition-all" onClick={() => setActiveTab('login')}>Login</button>
          <button className="btn-primary py-2 px-6 shadow-lg shadow-indigo-100 dark:shadow-none" onClick={() => setActiveTab('signup')}>Sign Up</button>
        </div>
      )}


    </div>
  </nav>
)

const EnergySinkGauge = ({ score }) => {
  const getColor = (s) => s > 60 ? 'text-rose-500' : (s > 30 ? 'text-amber-500' : 'text-emerald-500');
  const getLabel = (s) => s > 60 ? 'Avoid' : (s > 30 ? 'Apply Cautiously' : 'Apply Confidently');
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-24 h-24 flex items-center justify-center">
        <svg className="w-full h-full -rotate-90">
          <circle cx="48" cy="48" r="40" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-slate-100" />
          <circle cx="48" cy="48" r="40" stroke="currentColor" strokeWidth="8" fill="transparent" strokeDasharray={251.2} strokeDashoffset={251.2 - (251.2 * score) / 100} className={`${getColor(score)} transition-all duration-1000`} />
        </svg>
        <span className={`absolute text-2xl font-bold ${getColor(score)}`}>{score}</span>
      </div>
      <span className={`text-xs font-bold uppercase tracking-widest ${getColor(score)}`}>{getLabel(score)}</span>
    </div>
  )
}

const CommunityLeaderboard = ({ user }) => {
  const [leaderboard, setLeaderboard] = useState({ mostResponsive: [], topEnergySinks: [] })
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user?.token) return
    axios.get(`${API_URL}/api/community/leaderboard`, { headers: getAuthHeaders(user.token) })
      .then(res => {
        setLeaderboard(res.data || { mostResponsive: [], topEnergySinks: [] })
        setError('')
      })
      .catch(() => setError('Leaderboard data is unavailable until the backend is connected.'))
  }, [user?.token])

  const topCompanies = leaderboard.mostResponsive || []
  const energySinks = leaderboard.topEnergySinks || []

  return (
    <div className="pt-24 px-6 max-w-7xl mx-auto pb-32">
       <div className="text-center mb-16">
          <h2 className="text-4xl font-black text-slate-900 dark:text-white mb-4">Community Fairness Leaderboard</h2>
          <p className="text-slate-600 dark:text-slate-400 font-medium italic">Live company rollups from captured application signals.</p>
          {error && <p className="mt-4 text-sm font-bold text-amber-600">{error}</p>}
       </div>

       <div className="grid md:grid-cols-2 gap-12">
          <div>
             <h3 className="text-xl font-black mb-6 flex items-center gap-3 text-emerald-600">
                <CheckCircle size={24} /> Most Responsive
             </h3>
             <div className="space-y-4">
                {topCompanies.length ? topCompanies.map((c, i) => (
                   <div key={i} className="glass-card dark:bg-slate-900/50 flex items-center justify-between border-l-4 border-l-emerald-500">
                      <div>
                         <p className="font-black text-lg dark:text-white">{c.companyName}</p>
                         <div className="flex gap-4 mt-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{c.status}</span>
                            <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest">{c.applications} tracked jobs</span>
                         </div>
                      </div>
                      <div className="text-right">
                         <p className="text-2xl font-black text-emerald-600">{c.responseRate}%</p>
                         <p className="text-[10px] font-bold text-slate-400 uppercase">Yield</p>
                      </div>
                   </div>
                )) : <div className="glass-card dark:bg-slate-900/50 text-slate-500 font-bold">No response signals captured yet.</div>}
             </div>
          </div>

          <div>
             <h3 className="text-xl font-black mb-6 flex items-center gap-3 text-rose-600">
                <AlertCircle size={24} /> Top Energy Sinks
             </h3>
             <div className="space-y-4">
                {energySinks.length ? energySinks.map((c, i) => (
                   <div key={i} className="glass-card dark:bg-slate-900/50 flex items-center justify-between border-l-4 border-l-rose-500">
                      <div>
                         <p className="font-black text-lg dark:text-white">{c.companyName}</p>
                         <div className="flex gap-4 mt-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Sink Score: {c.averageEnergyScore}</span>
                            <span className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">High Complexity</span>
                         </div>
                      </div>
                      <div className="text-right">
                         <p className="text-2xl font-black text-rose-600">{c.responseRate}%</p>
                         <p className="text-[10px] font-bold text-slate-400 uppercase">Yield</p>
                      </div>
                   </div>
                )) : <div className="glass-card dark:bg-slate-900/50 text-slate-500 font-bold">No high sink companies detected yet.</div>}
             </div>
          </div>
       </div>

       <div className="mt-20 p-8 glass-card bg-indigo-600 text-white text-center">
          <h4 className="text-2xl font-black mb-4 italic">Is your company missing?</h4>
          <p className="text-indigo-100 font-medium mb-8 max-w-xl mx-auto">Verified recruiters can improve these metrics by sending timely response signals.</p>
          <button className="bg-white text-indigo-600 px-10 py-4 rounded-xl font-black tracking-wide hover:bg-indigo-50 transition-colors">Claim Company Profile</button>
       </div>
    </div>
  )
}

const LandingPage = ({ onGetStarted, setActiveTab }) => (
  <div className="pt-32 pb-20 px-6 max-w-7xl mx-auto">
    <div className="text-center mb-20 animate-in">
      <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-bold mb-6">
        <Sparkles size={16} /> [Apply Smart. Avoid Ghost Jobs.]
      </div>
      <h1 className="text-5xl md:text-7xl font-black text-slate-900 dark:text-white mb-8 leading-tight">
        Track employer responsiveness <br/><span className="text-indigo-600 dark:text-indigo-400">before you apply.</span>
      </h1>
      <p className="text-xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed font-medium">
        Trusted by job seekers worldwide. Measure the imbalance between applicant effort and employer response.
      </p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
        <button className="btn-primary text-lg px-10 py-4 shadow-xl shadow-indigo-100 dark:shadow-none flex items-center gap-2" onClick={onGetStarted}>
          <Globe size={20} /> Install Chrome Extension
        </button>
        <button className="btn-secondary text-lg px-10 py-4 dark:bg-slate-800 dark:text-white dark:border-slate-700" onClick={() => setActiveTab('how-it-works')}>View Demo</button>
      </div>
    </div>

    <div className="grid md:grid-cols-3 gap-8 mb-32">
       {[
         { icon: <Activity className="text-indigo-500" />, title: "Effort Mapping", desc: "Our browser extension detects form complexity, cover letter requirements, and time-to-fill." },
         { icon: <Shield className="text-emerald-500" />, title: "Privacy-Locked", desc: "No resume content, no private data. We only track metadata and anonymized signals." },
         { icon: <TrendingUp className="text-amber-500" />, title: "Response Rates", desc: "Aggregated evidence of real employer engagement to separate active leads from ghost listings." }
       ].map((f, i) => (
         <div key={i} className="glass-card dark:bg-slate-900/50 dark:border-slate-800">
           <div className="w-12 h-12 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center mb-6">{f.icon}</div>
           <h3 className="text-xl font-bold mb-3 dark:text-white">{f.title}</h3>
           <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{f.desc}</p>
         </div>
       ))}
    </div>
  </div>
)

const PersonalAnalytics = ({ analytics, lastUpdated }) => {
  const chartData = [
    { name: 'Applications', effort: analytics.totalApplications || 0, responses: analytics.summary?.responseCount || 0 },
    { name: 'Effort', effort: analytics.summary?.averageEffort || 0, responses: analytics.summary?.pendingResponseCount || 0 },
    { name: 'Average', effort: analytics.averageEnergyScore || 0, responses: analytics.averageResponseRate || 0 },
  ]

  const stats = [
    { label: 'Total Applications', value: analytics.totalApplications ?? 0, icon: Activity, color: 'text-indigo-500' },
    { label: 'Response Rate', value: `${analytics.averageResponseRate ?? 0}%`, icon: TrendingUp, color: 'text-emerald-500' },
    { label: 'Average Score', value: analytics.averageEnergyScore ?? 0, icon: Zap, color: 'text-amber-500' },
    { label: 'Last Updated', value: lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'No data', icon: Clock, color: 'text-rose-500' },
  ]

  const topRiskyCompanies = analytics.topRiskyCompanies || []
  const bestCompanies = analytics.bestCompanies || []

  return (
    <div className="pt-24 px-6 max-w-7xl mx-auto pb-20">
      <div className="mb-12">
        <h2 className="text-3xl font-black text-slate-900 dark:text-white">Your Analytics</h2>
        <p className="text-slate-600 dark:text-slate-400 font-medium tracking-tight">Live Data from Extension</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-12">
        {stats.map((s, i) => (
          <div key={i} className="glass-card dark:bg-slate-900/50">
            <s.icon className={`${s.color} mb-4`} size={24} />
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">{s.label}</p>
            <p className="text-2xl font-black dark:text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-8 mb-12">
        <div className="lg:col-span-2 glass-card dark:bg-slate-900/50 min-h-[320px]">
          <h3 className="text-lg font-black mb-8 dark:text-white flex items-center gap-2">
            <BarChart2 size={20} className="text-indigo-500" /> Extension Summary
          </h3>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip />
                <Line type="monotone" dataKey="effort" stroke="#6366f1" strokeWidth={4} dot={{ r: 6 }} />
                <Line type="monotone" dataKey="responses" stroke="#10b981" strokeWidth={4} dot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card dark:bg-slate-900/50">
          <h3 className="text-lg font-black mb-6 dark:text-white flex items-center gap-2">
            <AlertCircle size={20} className="text-rose-500" /> Top Risky Companies
          </h3>
          <div className="space-y-4">
            {topRiskyCompanies.length ? topRiskyCompanies.map((company, i) => (
              <div key={i} className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-100 dark:border-slate-800">
                <p className="text-sm font-bold dark:text-white">{company.companyName}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">{company.jobTitle}</p>
                <p className="text-sm font-black text-rose-500 mt-2">{company.energySinkScore}</p>
              </div>
            )) : <p className="text-sm text-slate-400">No data yet</p>}
          </div>
        </div>

        <div className="glass-card dark:bg-slate-900/50 lg:col-span-3">
          <h3 className="text-lg font-black mb-6 dark:text-white flex items-center gap-2">
            <CheckCircle size={20} className="text-emerald-500" /> Best Companies
          </h3>
          <div className="grid md:grid-cols-2 gap-4">
            {bestCompanies.length ? bestCompanies.map((company, i) => (
              <div key={i} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-100 dark:border-slate-800">
                <p className="text-sm font-bold dark:text-white">{company.companyName}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">{company.jobTitle}</p>
                <p className="text-sm font-black text-emerald-500 mt-2">{company.energySinkScore}</p>
              </div>
            )) : <p className="text-sm text-slate-400">No data yet</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

const RESPONSE_ACTIONS = [
  ['interview_detected', 'Interview'],
  ['rejection_detected', 'Rejected'],
  ['offer_detected', 'Offer'],
  ['no_response_after_delay', 'No Response'],
  ['application_acknowledged', 'Acknowledged'],
]

const ResponseDropdown = ({ job, onResponse, loading, error }) => {
  const [open, setOpen] = useState(false)
  const label = job?.responseStatus && job.responseStatus !== 'pending'
    ? `Response: ${formatResponseStatus(job).replace('Response ', '')}`
    : 'Response'

  const select = async (type) => {
    setOpen(false)
    await onResponse(job, type)
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        disabled={loading}
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-black text-slate-700 dark:text-slate-200 shadow-sm hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-500 disabled:opacity-60 whitespace-nowrap"
      >
        {loading ? 'Saving...' : label} <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 shadow-xl">
          {RESPONSE_ACTIONS.map(([type, optionLabel]) => (
            <button
              key={type}
              type="button"
              onClick={() => select(type)}
              className="block w-full px-4 py-2.5 text-left text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Mark {optionLabel}
            </button>
          ))}
        </div>
      )}
      {error && <div className="absolute right-0 top-full mt-12 w-44 text-left text-[11px] font-bold text-rose-500">Could not update response</div>}
    </div>
  )
}

const Dashboard = ({ jobs, onSelectJob, onNavigateToAnalytics, onRefresh, onResponse, lastUpdated, signalCount, latestScore }) => (
  <div className="pt-24 px-6 max-w-7xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
      <div>
        <h2 className="text-3xl font-black text-slate-900 dark:text-white">Dashboard</h2>
        <p className="text-slate-600 dark:text-slate-400 font-medium tracking-tight">Live Data from Extension</p>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-2">
          {signalCount ?? 0} signals captured - Latest Score {latestScore ?? 'Not enough data'}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={onRefresh} className="text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:underline">Refresh</button>
        <div className="text-sm font-bold text-slate-500 dark:text-slate-400">Last Updated: {formatTimestamp(lastUpdated)}</div>
      </div>
    </div>

    <div className="glass-card overflow-visible !p-0 border-slate-200 dark:border-slate-800 dark:bg-slate-900/50">
      <table className="w-full text-left">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
          <tr>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Job</th>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Company</th>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Energy Score</th>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Effort vs Response</th>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Recommendation</th>
            <th className="px-8 py-4 text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {jobs.length ? jobs.map((j) => (
            <tr key={j.jobId} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
              <td className="px-8 py-6 font-bold text-slate-900 dark:text-white">{j.jobTitle}</td>
              <td className="px-8 py-6 font-bold text-slate-900 dark:text-white">{j.companyName}</td>
              <td className="px-8 py-6">
                <div className="flex items-center gap-2">
                   <div className={`w-2 h-2 rounded-full ${getScoreDotClass(j)}`} />
                <span className="text-sm font-bold dark:text-slate-300 whitespace-nowrap">{formatScore(j)}</span>
                </div>
              </td>
              <td className="px-8 py-6">
                <span className="text-sm font-extrabold text-slate-700 dark:text-slate-300 whitespace-nowrap">{formatEffortResponse(j)}</span>
              </td>
              <td className="px-8 py-6">
                <span className={`text-xs font-bold px-2 py-1 rounded uppercase whitespace-nowrap ${getRecommendationClass(j)}`}>{formatRecommendation(j)}</span>
              </td>
              <td className="px-8 py-6 text-right">
                <div className="flex items-center justify-end gap-3">
                  <ResponseDropdown job={j} onResponse={onResponse} loading={j.responseUpdating} error={j.responseError} />
                  <button onClick={() => onSelectJob(j)} className="text-indigo-600 dark:text-indigo-400 font-bold text-sm hover:underline transition-all">View</button>
                </div>
              </td>
            </tr>
          )) : (
            <tr>
              <td colSpan="6" className="px-8 py-10 text-center text-slate-400 font-medium">No valid tracked jobs yet</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="p-6 bg-slate-50 dark:bg-slate-800/50 text-center">
        <button 
          onClick={onNavigateToAnalytics}
          className="text-indigo-600 dark:text-indigo-400 font-bold text-sm hover:underline flex items-center gap-2 justify-center mx-auto"
        >
          <BarChart2 size={16} /> View Personal Effort Analytics
        </button>
      </div>
    </div>
  </div>
)

const SocialButton = ({ label, onClick, brand }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center justify-center gap-3 py-3 px-4 border border-slate-200 dark:border-slate-800 rounded-lg font-bold bg-white dark:bg-slate-800 text-slate-700 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700 transition-all text-sm"
  >
    {brand === 'google' ? (
      <svg className="w-5 h-5" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
    ) : (
      <svg className="w-5 h-5" viewBox="0 0 23 23">
        <path fill="#f3f3f3" d="M0 0h23v23H0z"/>
        <path fill="#f35325" d="M1 1h10v10H1z"/>
        <path fill="#81bc06" d="M12 1h10v10H12z"/>
        <path fill="#05a6f0" d="M1 12h10v10H1z"/>
        <path fill="#ffba08" d="M12 12h10v10H12z"/>
      </svg>
    )}
    <span>{label}</span>
  </button>
)

const InputField = ({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  fullWidth = true,
  icon: Icon,
  onIconClick,
}) => (
  <div className={`${fullWidth ? 'w-full' : 'w-1/2'} mb-4 text-left`}>
    <label className="block text-xs font-bold text-slate-500 mb-1 ml-1">{label}</label>
    <div className="relative">
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg outline-none focus:border-indigo-500 transition-all font-medium text-sm text-slate-900 dark:text-white"
      />
      {Icon && (
        <Icon
          size={16}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer"
          onClick={onIconClick}
        />
      )}
    </div>
  </div>
)

const AuthModal = ({ mode = 'login', onClose, onAuth }) => {
  const [step, setStep] = useState(mode === 'signup' ? 'signup-form' : 'choice') 
  const [formData, setFormData] = useState({ firstName: '', lastName: '', email: '', password: '', confirmPassword: '' })
  const [otpCode, setOtpCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [verifiedAuth, setVerifiedAuth] = useState(null)
  const [resetOtp, setResetOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const bypassOtpForLocalSignup = true
  const isSignupReady = (
    agreedToTerms &&
    formData.email &&
    formData.password &&
    formData.confirmPassword &&
    formData.password === formData.confirmPassword &&
    !isLoading
  )

  const handleAction = async (nextStep, delay = 1000) => {
    setIsLoading(true)
    setError('')
    try {
        if (step === 'signup-form') {
          if (!formData.password || !formData.confirmPassword) {
            setError('Please enter and confirm your password.')
            return
          }
          if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match.')
            return
          }
        }
        if (nextStep === 'otp' && step === 'signup-form') {
            const normalizedEmail = formData.email.trim().toLowerCase()
            if (bypassOtpForLocalSignup) {
              const res = await axios.post(`${API_URL}/api/auth/signup-bypass`, {
                name: `${formData.firstName} ${formData.lastName}`.trim() || formData.email.split('@')[0],
                email: normalizedEmail,
                password: formData.password,
              })
              setVerifiedAuth(res.data)
              nextStep = 'role'
            } else {
              await axios.post(`${API_URL}/api/auth/request-otp`, {
                email: normalizedEmail,
                name: `${formData.firstName} ${formData.lastName}`.trim(),
                password: formData.password,
              })
            }
        }
        if (nextStep === 'verifying') {
            const normalizedEmail = formData.email.trim().toLowerCase()
            const res = await axios.post(`${API_URL}/api/auth/login`, {
              email: normalizedEmail,
              password: formData.password,
            })
            const apiUser = res.data.user
            const authenticatedApiUser = {
              ...apiUser,
              token: res.data.access_token,
              avatar: `https://i.pravatar.cc/150?u=${apiUser.email}`,
            }
            saveLocalUser({
              ...authenticatedApiUser,
              password: formData.password,
            })
            onAuth(authenticatedApiUser)
            return
        }
        await new Promise(r => setTimeout(r, delay))
        setStep(nextStep)
    } catch (err) {
        setError(err.response?.data?.detail || "Connection refused. Please check if backend is running.")
    } finally {
        setIsLoading(false)
    }
  }

  const handleSocialMock = () => {
    setError("Social Authentication is in sandbox mode. Please use Email Signup for now.")
    setTimeout(() => setError(''), 3000)
  }

  const handleOtpVerify = async () => {
    setIsLoading(true)
    setError('')
    try {
        if (bypassOtpForLocalSignup) {
          // TEMP OTP BYPASS: OTP verification is intentionally skipped for local signup.
          setStep('role')
          return
        }
        /*
        const res = await axios.post(`${API_URL}/api/auth/verify-otp`, { email: formData.email, otp: otpCode })
        setVerifiedAuth(res.data)
        // On first verify, we send them to role selection
        */
        setStep('role')
    } catch (err) {
        setError(err.response?.data?.detail || "Invalid OTP")
    } finally {
        setIsLoading(false)
    }
  }

  const handleFinalAuth = (role) => {
    const apiUser = verifiedAuth?.user || {}
    const finalizedUser = { 
      ...apiUser,
      name: apiUser.name || (formData.firstName ? `${formData.firstName} ${formData.lastName}` : (formData.email.split('@')[0] || 'User')), 
      email: apiUser.email || formData.email, 
      role: apiUser.role || role, 
      token: verifiedAuth?.access_token,
      avatar: `https://i.pravatar.cc/150?u=${formData.email}`,
      isEmailVerified: true,
      isOnboarded: true // Mark as onboarded so OTP isn't asked again
    }
    saveLocalUser({
      ...finalizedUser,
      password: formData.password || apiUser.password,
    })
    onAuth(finalizedUser)
  }

  const handleForgotPassword = async () => {
    setIsLoading(true)
    setError('')
    try {
      await axios.post(`${API_URL}/api/auth/forgot-password`, { email: formData.email.trim().toLowerCase() })
      setStep('reset-password')
    } catch (err) {
      setError(err.response?.data?.detail || 'Unable to send reset code.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleResetPassword = async () => {
    setIsLoading(true)
    setError('')
    try {
      await axios.post(`${API_URL}/api/auth/reset-password`, {
        email: formData.email.trim().toLowerCase(),
        otp: resetOtp,
        new_password: newPassword,
      })
      setFormData({ ...formData, password: newPassword })
      setStep('password')
    } catch (err) {
      setError(err.response?.data?.detail || 'Unable to reset password.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 w-full max-w-[500px] rounded-3xl shadow-2xl overflow-hidden relative border border-slate-100 dark:border-slate-800">
        <button onClick={onClose} className="absolute top-6 right-6 p-2 text-slate-400 hover:text-slate-900 dark:hover:text-white z-10">
          <X size={20} />
        </button>

        <div className="p-10">
          {error && (
            <MotionDiv initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800 rounded-xl flex items-center gap-3 text-rose-600 dark:text-rose-400 text-sm font-bold">
               <AlertCircle size={18} />
               {error}
            </MotionDiv>
          )}
          <AnimatePresence mode="wait">
            {step === 'signup-form' && (
              <MotionDiv key="signup" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.05 }} className="text-center">
                <div className="flex flex-col items-center gap-2 mb-8">
                  <div className="flex items-center gap-2">
                    <User className="text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 p-1 rounded-md" size={24} />
                    <span className="font-black text-2xl text-slate-900 dark:text-white">Jobsoid</span>
                  </div>
                </div>

                <div className="flex gap-4 mb-6">
                   <SocialButton label="Sign up with Google" brand="google" onClick={handleSocialMock} />
                   <SocialButton label="Sign up with Microsoft" brand="microsoft" onClick={handleSocialMock} />
                </div>

                <div className="relative flex items-center justify-center mb-6">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100 dark:border-slate-800"></div></div>
                  <span className="relative px-4 bg-white dark:bg-slate-900 text-[10px] font-bold text-slate-400 uppercase tracking-widest">or sign up with email</span>
                </div>

                <div className="flex gap-4">
                  <InputField label="First Name" placeholder="John" value={formData.firstName} onChange={e => setFormData({...formData, firstName: e.target.value})} fullWidth={false} />
                  <InputField label="Last Name" placeholder="Doe" value={formData.lastName} onChange={e => setFormData({...formData, lastName: e.target.value})} fullWidth={false} />
                </div>
                <InputField label="Email" placeholder="your@email.com" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                <InputField label="Password" type={showPassword ? "text" : "password"} icon={showPassword ? EyeOff : Eye} onIconClick={() => setShowPassword(!showPassword)} placeholder="••••••••" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
                <InputField label="Confirm Password" type={showPassword ? "text" : "password"} icon={showPassword ? EyeOff : Eye} onIconClick={() => setShowPassword(!showPassword)} placeholder="••••••••" value={formData.confirmPassword} onChange={e => setFormData({...formData, confirmPassword: e.target.value})} />

                <div className="flex items-center gap-3 mb-8 text-left">
                  <input type="checkbox" checked={agreedToTerms} onChange={() => setAgreedToTerms(!agreedToTerms)} className="w-4 h-4 rounded border-slate-200 text-indigo-600 focus:ring-indigo-600 cursor-pointer" />
                  <span className="text-xs font-bold text-slate-500">I agree to the <span className="text-indigo-600 cursor-pointer">terms of service</span> and <span className="text-indigo-600 cursor-pointer">privacy policy</span></span>
                </div>

                <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-100 dark:border-slate-800 mb-8 flex items-center justify-between">
                   <div className="flex items-center gap-3">
                     <div className="w-6 h-6 bg-emerald-500 rounded flex items-center justify-center text-white"><Check size={14} /></div>
                     <span className="text-xs font-black text-slate-900 dark:text-white italic uppercase tracking-tighter">Success!</span>
                   </div>
                   <div className="text-[10px] flex flex-col items-end opacity-60">
                     <span className="font-bold">CLOUDFLARE</span>
                     <span>Privacy - Terms</span>
                   </div>
                </div>

                <button 
                  disabled={!isSignupReady}
                  onClick={() => handleAction('otp')}
                  className="btn-primary w-full py-4 text-center font-black tracking-wide text-sm disabled:opacity-50"
                >
                  {isLoading ? <Loader2 size={20} className="mx-auto animate-spin" /> : 'Sign Up'}
                </button>
              </MotionDiv>
            )}

            {step === 'choice' && (
              <MotionDiv key="choice" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }}>
                <h3 className="text-3xl font-black mb-2 text-slate-900 dark:text-white">Welcome Back</h3>
                <p className="text-slate-500 dark:text-slate-400 font-medium mb-10">Select your preferred entry method.</p>
                <div className="space-y-4 mb-10">
                   <SocialButton label="Continue with Google" brand="google" onClick={handleSocialMock} />
                </div>
                <div className="flex items-center gap-4 mb-8">
                  <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">OR USE EMAIL</span>
                  <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                </div>
                <div className="space-y-4 text-left">
                   <InputField label="Email Address" type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} placeholder="name@company.com" />
                   <button onClick={() => handleAction('password')} className="btn-primary w-full py-4">Continue</button>
                </div>
              </MotionDiv>
            )}

            {step === 'password' && (
              <MotionDiv key="password" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}>
                <h3 className="text-3xl font-black mb-2 text-slate-900 dark:text-white text-center">Secure Access</h3>
                <p className="text-slate-500 dark:text-slate-400 font-medium mb-10 text-center">{formData.email}</p>
                <InputField label="Password" type={showPassword ? "text" : "password"} icon={showPassword ? EyeOff : Eye} onIconClick={() => setShowPassword(!showPassword)} value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
                <button onClick={() => handleAction('verifying')} className="btn-primary w-full py-4 mt-6">Login</button>
                <button onClick={handleForgotPassword} className="w-full mt-4 text-sm font-bold text-indigo-600 dark:text-indigo-400">Forgot password?</button>
              </MotionDiv>
            )}

            {step === 'reset-password' && (
              <MotionDiv key="reset-password" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}>
                <h3 className="text-3xl font-black mb-2 text-slate-900 dark:text-white text-center">Reset Password</h3>
                <p className="text-slate-500 dark:text-slate-400 font-medium mb-10 text-center">{formData.email}</p>
                <InputField label="Reset Code" value={resetOtp} onChange={e => setResetOtp(e.target.value)} />
                <InputField label="New Password" type={showPassword ? "text" : "password"} icon={showPassword ? EyeOff : Eye} onIconClick={() => setShowPassword(!showPassword)} value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                <button disabled={!resetOtp || !newPassword || isLoading} onClick={handleResetPassword} className="btn-primary w-full py-4 mt-6 disabled:opacity-50">
                  {isLoading ? <Loader2 size={20} className="mx-auto animate-spin" /> : 'Update Password'}
                </button>
              </MotionDiv>
            )}

            {step === 'otp' && (
               <MotionDiv key="otp" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center">
                 <div className="flex flex-col items-center gap-2 mb-8">
                   <div className="flex items-center gap-2">
                     <div className="w-8 h-8 flex items-center justify-center">
                       <User className="text-amber-500" size={32} />
                     </div>
                     <span className="font-bold text-4xl text-slate-800 dark:text-white tracking-tight">Jobsoid</span>
                   </div>
                 </div>

                 <h3 className="text-2xl font-black mb-2 text-slate-800 dark:text-white">We just sent a code to</h3>
                 <p className="text-slate-600 dark:text-slate-300 font-bold mb-8">{formData.email}</p>
                 
                 <p className="text-sm font-medium text-slate-500 mb-6">Please enter the code to verify the account</p>

                 <div className="mb-6">
                   <input 
                    type="text" 
                    placeholder="Code" 
                    className="w-full px-6 py-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg outline-none focus:border-blue-500 text-lg font-medium text-slate-800 dark:text-white text-center"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                   />
                 </div>

                 <div className="mb-8">
                    <p className="text-sm font-bold text-slate-800 dark:text-white">Your Code will expire in 05:00 min</p>
                    <p className="text-sm text-slate-400 mt-2">Didn't get it? <span className="text-slate-300 cursor-pointer hover:text-blue-500 transition-colors">Resend</span></p>
                 </div>

                 <button 
                  onClick={handleOtpVerify}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-all shadow-lg active:scale-95"
                 >
                   Submit
                 </button>
               </MotionDiv>
            )}


            {step === 'role' && (
              <MotionDiv key="role" initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}>
                <h3 className="text-3xl font-black mb-8 text-slate-900 dark:text-white text-center">Select Role</h3>
                <div className="space-y-4">
                  {['Job Seeker', 'Recruiter', 'Admin'].map(r => (
                    <button key={r} onClick={() => handleFinalAuth(r)} className="w-full p-6 border-2 border-slate-100 dark:border-slate-800 rounded-2xl hover:border-indigo-600 transition-all text-left font-black text-slate-900 dark:text-white">
                      {r}
                    </button>
                  ))}
                </div>
              </MotionDiv>
            )}
            
            {step === 'verifying' && (
              <MotionDiv key="verifying" className="text-center py-20">
                <Loader2 size={40} className="mx-auto animate-spin text-indigo-600 mb-6" />
                <h3 className="text-xl font-black">Syncing Protocols...</h3>
              </MotionDiv>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}


const HowItWorks = () => (
    <div className="pt-24 px-6 max-w-3xl mx-auto pb-32">
        <h1 className="text-4xl font-black mb-12 dark:text-white">The Science of Energy Sinks</h1>
        <div className="space-y-12">
            {[
                { step: "01", title: "Wait-Time Detection", desc: "Our system measures how long job postings remain active without hiring signals." },
                { step: "02", title: "Effort Normalization", desc: "We convert resume requirements, custom portals, and cover letter needs into standardized 'Effort Points'." },
                { step: "03", title: "The Ratio", desc: "The Energy Sink Score is calculated as Effort per Meaningful Response. High scores indicate possible 'Ghost Jobs'." }
            ].map((s, i) => (
                <div key={i} className="flex gap-8">
                    <span className="text-5xl font-black text-slate-100 dark:text-slate-800">{s.step}</span>
                    <div className="pt-2">
                        <h3 className="text-xl font-bold mb-2 dark:text-white">{s.title}</h3>
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed italic">{s.desc}</p>
                    </div>
                </div>
            ))}
        </div>
    </div>
)

const JobDetailView = ({ job, onBack, onResponse, onAnalyzeMetadata }) => (
  <div className="pt-24 px-6 max-w-4xl mx-auto pb-32">
    <button onClick={onBack} className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-bold mb-8 hover:gap-3 transition-all">
      <ArrowRight size={20} className="rotate-180" /> Back to Dashboard
    </button>

    <div className="glass-card dark:bg-slate-900/50 dark:border-slate-800 mb-8 overflow-hidden !p-0">
      <div className={`p-4 text-center font-black uppercase tracking-widest text-white ${job.scoreStatus !== 'scored' ? 'bg-slate-500' : (job.energySinkScore >= 70 ? 'bg-rose-500' : (job.energySinkScore >= 40 ? 'bg-amber-500' : 'bg-emerald-500'))}`}>
        {formatRecommendation(job)}
      </div>
      <div className="p-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-3xl font-black text-slate-900 dark:text-white mb-2">{job.companyName}</h2>
          <p className="text-xl text-slate-600 dark:text-slate-400 font-bold">{job.jobTitle}</p>
        </div>
        <EnergySinkGauge score={job.scoreStatus === 'scored' ? Math.round(job.energySinkScore) : 0} />
      </div>
    </div>

    <div className="grid md:grid-cols-2 gap-8">
      <div className="glass-card dark:bg-slate-900/50 dark:border-slate-800">
        <h3 className="font-bold text-slate-400 dark:text-slate-500 uppercase text-xs tracking-widest mb-6">Effort Metrics</h3>
        <div className="space-y-4">
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Time Spent</span>
            <span className="text-indigo-600">{job.totalTimeSpent}s</span>
          </div>
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Max Scroll Depth</span>
            <span className="text-amber-500">{job.maxScrollDepth}</span>
          </div>
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Apply Clicks</span>
            <span className="text-rose-500">{job.applyClicks}</span>
          </div>
          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center font-black">
            <span className="text-slate-900 dark:text-white">Effort Score</span>
            <span className="text-indigo-600">{job.effortScore}</span>
          </div>
        </div>
      </div>
      <div className="glass-card dark:bg-slate-900/50 dark:border-slate-800">
        <h3 className="font-bold text-slate-400 dark:text-slate-500 uppercase text-xs tracking-widest mb-6">Response Metrics</h3>
        <div className="space-y-4">
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Response</span>
            <span className="text-emerald-500">{formatResponseStatus(job)}</span>
          </div>
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Delay Penalty</span>
            <span className="text-slate-900 dark:text-white">{job.delayPenalty ?? 0}</span>
          </div>
          <div className="flex justify-between items-center text-sm font-bold">
            <span className="text-slate-600 dark:text-slate-400">Last Interaction</span>
            <span className="text-slate-900 dark:text-white">{formatTimestamp(job.lastInteractionTime)}</span>
          </div>
        </div>
        <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-2">
          {RESPONSE_ACTIONS.map(([type, label]) => (
            <button key={type} onClick={() => onResponse(job, type)} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300">
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
    <EmailMetadataCheck job={job} onAnalyze={onAnalyzeMetadata} />
  </div>
)

const EmailMetadataCheck = ({ job, onAnalyze }) => {
  const [sender, setSender] = useState('')
  const [subject, setSubject] = useState('')
  const [status, setStatus] = useState('')
  const submit = async () => {
    setStatus('Checking...')
    const result = await onAnalyze(job, { sender, subject, timestamp: new Date().toISOString() })
    setStatus(result?.matched ? `${formatResponseStatus({ responseStatus: result.responseType?.replace('_detected', '').replace('application_acknowledged', 'acknowledged') })}` : (result?.reason || 'No match'))
  }
  return (
    <div className="glass-card dark:bg-slate-900/50 dark:border-slate-800 mt-8">
      <h3 className="font-bold text-slate-400 dark:text-slate-500 uppercase text-xs tracking-widest mb-4">Email Metadata Check</h3>
      <div className="grid md:grid-cols-2 gap-3">
        <input className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm" placeholder="sender@company.com" value={sender} onChange={e => setSender(e.target.value)} />
        <input className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm" placeholder="Subject line" value={subject} onChange={e => setSubject(e.target.value)} />
      </div>
      <button onClick={submit} className="mt-3 text-indigo-600 dark:text-indigo-400 text-sm font-bold hover:underline">Analyze Metadata</button>
      {status && <div className="mt-2 text-xs font-bold text-slate-500">{status}</div>}
    </div>
  )
}

const VerifyEmailView = ({ email, onVerify }) => (
  <div className="pt-32 px-6 max-w-md mx-auto text-center">
    <div className="w-20 h-20 bg-indigo-50 dark:bg-indigo-900/30 rounded-full flex items-center justify-center mx-auto mb-8 text-indigo-600">
      <Mail size={40} />
    </div>
    <h2 className="text-3xl font-black text-slate-900 dark:text-white mb-4">Check your inbox</h2>
    <p className="text-slate-600 dark:text-slate-400 mb-8 font-medium italic">We sent a verification link to <br/><span className="text-slate-900 dark:text-white font-bold">{email}</span></p>
    <div className="space-y-4">
      <button onClick={onVerify} className="btn-primary w-full py-4">I've verified my email</button>
      <button className="w-full text-slate-400 font-bold text-sm hover:text-indigo-600 transition-colors">Resend Code (59s)</button>
    </div>
  </div>
)

const OnboardingView = ({ onComplete }) => (
  <div className="pt-32 px-6 max-w-2xl mx-auto text-center">
    <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded-full text-sm font-bold mb-8">
      <CheckCircle size={16} /> Welcome to the Community
    </div>
    <h2 className="text-4xl font-black text-slate-900 dark:text-white mb-6">Let's shield your job search.</h2>
    <div className="grid sm:grid-cols-2 gap-6 mb-12 text-left">
       <div className="p-6 bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
          <Zap className="text-amber-500 mb-4" />
          <h4 className="font-bold mb-2 dark:text-white">Active Scans</h4>
          <p className="text-sm text-slate-500 dark:text-slate-400">Install the extension to start scanning job posts in real-time.</p>
       </div>
       <div className="p-6 bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
          <Shield className="text-indigo-500 mb-4" />
          <h4 className="font-bold mb-2 dark:text-white">Privacy Lock</h4>
          <p className="text-sm text-slate-500 dark:text-slate-400">Your data is hashed and encrypted. We never share your resume.</p>
       </div>
    </div>
    <button onClick={onComplete} className="btn-primary px-12 py-4 text-lg">Enter Dashboard</button>
  </div>
)

const EmployerDashboard = ({ user }) => {
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!user?.token) return
    axios.get(`${API_URL}/api/employer/dashboard`, { headers: getAuthHeaders(user.token) })
      .then(res => setData(res.data))
      .catch(() => setData(null))
  }, [user?.token])

  return (
  <div className="pt-24 px-6 max-w-7xl mx-auto">
    <div className="flex items-center justify-between mb-12">
      <div>
        <h2 className="text-3xl font-black text-slate-900 dark:text-white">Recruiter Signal</h2>
        <p className="text-slate-600 dark:text-slate-400 font-medium italic">Manage your company's transparency score.</p>
      </div>
      <button className="btn-primary">+ Create Verified Post</button>
    </div>
    <div className="grid md:grid-cols-3 gap-8">
       <div className="glass-card dark:bg-slate-900/50">
          <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Trust Rating</h4>
          <div className="text-4xl font-black text-emerald-500">{data?.trustRating || 'Needs Data'}</div>
       </div>
       <div className="glass-card dark:bg-slate-900/50">
          <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Active Applicants</h4>
          <div className="text-4xl font-black text-indigo-500">{data?.activeApplicants ?? 0}</div>
       </div>
       <div className="glass-card dark:bg-slate-900/50">
          <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Response Velocity</h4>
          <div className="text-4xl font-black text-slate-900 dark:text-white">{data?.responseVelocityDays ?? 0} Days</div>
       </div>
    </div>
  </div>
)
}

const AdminDashboard = ({ user }) => {
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!user?.token) return
    axios.get(`${API_URL}/api/admin/dashboard`, { headers: getAuthHeaders(user.token) })
      .then(res => setData(res.data))
      .catch(() => setData(null))
  }, [user?.token])

  return (
    <div className="pt-24 px-6 max-w-7xl mx-auto">
      <h2 className="text-3xl font-black text-slate-900 dark:text-white mb-12">Admin Control Center</h2>
      <div className="grid md:grid-cols-3 gap-8">
        <div className="glass-card dark:bg-slate-900/50"><h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Users</h4><div className="text-4xl font-black text-indigo-500">{data?.users ?? 0}</div></div>
        <div className="glass-card dark:bg-slate-900/50"><h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Signals</h4><div className="text-4xl font-black text-emerald-500">{data?.signals ?? 0}</div></div>
        <div className="glass-card dark:bg-slate-900/50"><h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Tracked Jobs</h4><div className="text-4xl font-black text-slate-900 dark:text-white">{data?.trackedJobs ?? 0}</div></div>
      </div>
    </div>
  )
}

const IntegrationsView = ({ user, isEmailSynced, setIsEmailSynced }) => {
  const [headersText, setHeadersText] = useState('')
  const [status, setStatus] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const parseHeaders = () => {
    if (!headersText.trim()) {
      return []
    }
    return headersText.split('\n').map((line) => {
      const [from = '', subject = ''] = line.split('|')
      return { from: from.trim(), subject: subject.trim() }
    }).filter((header) => header.from || header.subject)
  }

  const connectGmail = async () => {
    if (!user?.token) {
      setStatus('Login required')
      return
    }
    setIsLoading(true)
    setStatus('')
    try {
      const res = await axios.post(
        `${API_URL}/api/integrations/gmail/connect`,
        { headers: parseHeaders() },
        { headers: getAuthHeaders(user.token) },
      )
      setIsEmailSynced(true)
      setStatus(`Connected. ${res.data.signal_count || 0} email signals detected.`)
    } catch (error) {
      setStatus(error.response?.data?.detail || 'Unable to connect Gmail analysis.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="pt-32 px-6 max-w-2xl mx-auto">
      <h2 className="text-3xl font-black mb-8 dark:text-white">Connection Suite</h2>
      <div className="glass-card dark:bg-slate-900/50">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
             <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center text-indigo-600">
                <Mail size={24} />
             </div>
             <div>
                <h4 className="font-bold dark:text-white">Direct Email Relay</h4>
                <p className="text-xs text-slate-500 font-medium">Analyzes only sender and subject headers for response tracking.</p>
             </div>
          </div>
          <button
            onClick={() => isEmailSynced ? setIsEmailSynced(false) : connectGmail()}
            disabled={isLoading}
            className={`px-6 py-2 rounded-lg font-bold text-sm transition-all disabled:opacity-50 ${isEmailSynced ? 'bg-rose-50 dark:bg-rose-900/20 text-rose-600' : 'bg-indigo-600 text-white'}`}
          >
            {isLoading ? 'Connecting...' : (isEmailSynced ? 'Disconnect' : 'Connect Gmail')}
          </button>
        </div>
        <textarea
          value={headersText}
          onChange={(event) => setHeadersText(event.target.value)}
          placeholder="sender@example.com | Interview invitation"
          className="mt-6 w-full min-h-28 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-sm outline-none focus:border-indigo-500"
        />
        {status && <p className="mt-4 text-sm font-bold text-slate-600 dark:text-slate-300">{status}</p>}
      </div>
    </div>
  )
}

const PrivacyPage = () => (
  <div className="pt-32 px-6 max-w-3xl mx-auto pb-32">
    <h1 className="text-4xl font-black mb-8 dark:text-white">Our Privacy-First Protocol</h1>
    <p className="text-slate-600 dark:text-slate-400 text-lg leading-relaxed mb-12 italic">
      We believe you shouldn't have to trade your data for transparency. 
      JobZoid is built on a "Privacy-Locked" architecture.
    </p>
    <div className="space-y-8">
      {[
        { title: "No Resume Storage", desc: "Our extension never reads the content of your PDF or Word resumes. We only detect THAT you uploaded a file." },
        { title: "No Email Content Access", desc: "If you connect your email, we only read metadata (headers, timestamps) to verify employer responses. We never read the body of your emails." },
        { title: "Anonymized Hashing", desc: "Job URLs are hashed before they reach our servers, ensuring your specific browsing history is protected." }
      ].map((p, i) => (
        <div key={i} className="border-l-4 border-indigo-600 dark:border-indigo-400 pl-8 py-2">
          <h3 className="text-xl font-bold mb-2 dark:text-white">{p.title}</h3>
          <p className="text-slate-600 dark:text-slate-400 leading-relaxed font-medium">{p.desc}</p>
        </div>
      ))}
    </div>
  </div>
)

function App() {
  const [user, setUser] = useState(() => getStoredSessionUser())
  const [activeTab, setActiveTab] = useState('home')
  const [selectedJob, setSelectedJob] = useState(null)
  const [extensionLoginPrompt, setExtensionLoginPrompt] = useState(false)
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme')
    console.log("Initial theme from storage:", saved)
    return saved === 'dark' ? 'dark' : 'light'
  })
  const [jobs, setJobs] = useState([])
  const [analytics, setAnalytics] = useState({})
  const [dashboardError, setDashboardError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [signalStats, setSignalStats] = useState({ signalCount: 0, latestScore: 0 })
  const [isEmailSynced, setIsEmailSynced] = useState(false)

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    localStorage.setItem('theme', nextTheme)
  }

  useEffect(() => {
    const root = window.document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('source') === 'extension' && !user) {
      setExtensionLoginPrompt(true)
      setActiveTab('login')
    }
  }, [user])

  useEffect(() => {
    if (!user) {
      return
    }
    if (['home', 'login', 'signup'].includes(activeTab)) {
      setActiveTab('dashboard')
      return
    }
  }, [user, activeTab])

  useEffect(() => {
    if (!user) {
      return
    }
    const roleRoute = user.role === 'Recruiter' ? 'employer-dashboard' :
      user.role === 'Admin' ? 'admin-dashboard' : 'dashboard'
    setActiveTab(roleRoute)
  }, [user])

  const loadDashboardData = useCallback(async () => {
    if (!user?.token) {
      setJobs([])
      setAnalytics({})
      setLastUpdated(null)
      setSignalStats({ signalCount: 0, latestScore: 0 })
      return
    }

    const headers = getAuthHeaders(user.token)
    const [dashboardRes, analyticsRes] = await Promise.all([
      axios.get(`${API_URL}/api/dashboard`, { headers }),
      axios.get(`${API_URL}/api/analytics`, { headers }),
    ])
    const dashboardJobs = dashboardRes.data.jobs || []
    const derivedAnalytics = buildAnalyticsFromJobs(dashboardJobs, dashboardRes.data.signalCount ?? 0, dashboardRes.data.lastUpdated || null)
    const backendAnalytics = analyticsRes.data || {}
    setJobs(dashboardJobs)
    setAnalytics((backendAnalytics.totalApplications || 0) > 0 ? backendAnalytics : derivedAnalytics)
    setSignalStats({
      signalCount: dashboardRes.data.signalCount ?? analyticsRes.data.signalCount ?? 0,
      latestScore: dashboardRes.data.latestScore ?? 0,
    })
    setLastUpdated(dashboardRes.data.lastUpdated || analyticsRes.data.lastUpdated || null)
    setDashboardError('')
  }, [user?.token])

  useEffect(() => {
    if (!user?.token) {
      loadDashboardData()
      return
    }

    let cancelled = false

    const loadData = async () => {
      try {
        if (!cancelled) {
          await loadDashboardData()
        }
      } catch (error) {
        if (!cancelled) {
          if (error.response?.status === 401) {
            setDashboardError('Unauthorized user')
            setUser(null)
            clearSessionUser()
            setActiveTab('login')
          } else {
            setDashboardError('Backend not connected')
          }
        }
      }
    }

    loadData()
    const handleFocus = () => loadData()
    window.addEventListener('focus', handleFocus)
    const intervalId = window.setInterval(loadData, 10000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', handleFocus)
      window.clearInterval(intervalId)
    }
  }, [user?.token, loadDashboardData])

  const handleAuth = (userData) => {
    console.log("Authenticated User:", userData)
    setUser(userData)
    setExtensionLoginPrompt(false)
    saveSessionUser(userData)
    
    // START INTELLIGENT ROUTING
    if (!userData.isEmailVerified) {
        setActiveTab('verify-email')
    } else if (!userData.isOnboarded) {
        setActiveTab('onboarding')
    } else {
        const roleRoute = userData.role === 'Recruiter' ? 'employer-dashboard' : 
                         userData.role === 'Admin' ? 'admin-dashboard' : 'dashboard'
        setActiveTab(roleRoute)
    }
  }

  const handleSignOut = () => {
    setUser(null)
    clearSessionUser()
    setActiveTab('home')
    setSelectedJob(null)
  }

  const handleResponseUpdate = async (job, responseType) => {
    if (!user?.token || !job?.jobId) return
    setJobs(current => current.map(item => item.jobId === job.jobId ? { ...item, responseUpdating: true, responseError: false } : item))
    try {
      const res = await axios.post(
        `${API_URL}/api/jobs/${encodeURIComponent(job.jobId)}/response`,
        { responseType, source: 'manual', timestamp: new Date().toISOString() },
        { headers: getAuthHeaders(user.token) },
      )
      console.debug('AESD response dropdown updated', {
        selectedResponseType: responseType,
        apiStatus: res.status,
        updatedResponseStatus: res.data?.responseStatus,
        updatedRecommendation: res.data?.recommendation,
      })
      setJobs(current => current.map(item => item.jobId === job.jobId ? { ...item, ...res.data, responseUpdating: false, responseError: false } : item))
      setSelectedJob(current => current?.jobId === job.jobId ? { ...current, ...res.data } : current)
      await loadDashboardData()
    } catch (error) {
      setJobs(current => current.map(item => item.jobId === job.jobId ? { ...item, responseUpdating: false, responseError: true } : item))
    }
  }

  const handleAnalyzeMetadata = async (job, email) => {
    if (!user?.token || !job?.jobId) return null
    const res = await axios.post(
      `${API_URL}/api/email/analyze-metadata`,
      { jobId: job.jobId, company: job.companyName, emails: [email] },
      { headers: getAuthHeaders(user.token) },
    )
    await loadDashboardData()
    setSelectedJob(current => current?.jobId === job.jobId ? { ...current, responseStatus: res.data.responseType?.replace('_detected', '').replace('application_acknowledged', 'acknowledged') } : current)
    return res.data
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-sans selection:bg-indigo-100 dark:selection:bg-indigo-900 selection:text-indigo-900 dark:selection:text-indigo-100 transition-colors duration-300">
      <Nav user={user} activeTab={activeTab} setActiveTab={setActiveTab} onSignOut={handleSignOut} theme={theme} toggleTheme={toggleTheme} />
      
      <main className="animate-in">
        {extensionLoginPrompt && activeTab === 'login' && (
          <div className="pt-24 px-6 max-w-2xl mx-auto">
            <div className="mb-4 p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800 rounded-xl text-indigo-700 dark:text-indigo-300 text-sm font-bold">
              Login to connect your AESD Extension
            </div>
          </div>
        )}
        {activeTab === 'home' && <LandingPage onGetStarted={() => user ? handleAuth(user) : setActiveTab('login')} setActiveTab={setActiveTab} />}
        {dashboardError && activeTab === 'dashboard' && (
          <div className="pt-24 px-6 max-w-7xl mx-auto">
            <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl text-amber-700 dark:text-amber-300 text-sm font-bold">
              {dashboardError}
            </div>
          </div>
        )}
        {activeTab === 'dashboard' && !selectedJob && (
          <Dashboard
            jobs={jobs}
            onSelectJob={setSelectedJob}
            onNavigateToAnalytics={() => setActiveTab('analytics')}
            onRefresh={loadDashboardData}
            onResponse={handleResponseUpdate}
            lastUpdated={lastUpdated}
            signalCount={signalStats.signalCount}
            latestScore={signalStats.latestScore}
          />
        )}
        {activeTab === 'analytics' && <PersonalAnalytics analytics={analytics} lastUpdated={lastUpdated} />}
        {activeTab === 'leaderboard' && <CommunityLeaderboard user={user} />}
        {activeTab === 'employer-dashboard' && <EmployerDashboard user={user} />}
        {activeTab === 'admin-dashboard' && <AdminDashboard user={user} />}
        {activeTab === 'verify-email' && <VerifyEmailView email={user?.email} onVerify={() => handleAuth({...user, isEmailVerified: true})} />}
        {activeTab === 'onboarding' && <OnboardingView onComplete={() => handleAuth({...user, isOnboarded: true})} />}
        {activeTab === 'dashboard' && selectedJob && <JobDetailView job={selectedJob} onBack={() => setSelectedJob(null)} onResponse={handleResponseUpdate} onAnalyzeMetadata={handleAnalyzeMetadata} />}
        {activeTab === 'integrations' && <IntegrationsView user={user} isEmailSynced={isEmailSynced} setIsEmailSynced={setIsEmailSynced} />}
        {activeTab === 'how-it-works' && <HowItWorks />}
        {activeTab === 'privacy' && <PrivacyPage />}
        {activeTab === 'about' && (
            <div className="pt-32 px-6 max-w-2xl mx-auto text-center">
                <h1 className="text-4xl font-black mb-8 italic dark:text-white">Applicant Protection is our Mission.</h1>
                <p className="text-slate-600 dark:text-slate-400 text-lg leading-relaxed font-medium">
                    We believe the job search is fundamentally imbalanced. 
                    Employers hold data; applicants hold hope. <br/><br/>
                    AESD (Applicant Energy Sink Detector) was built to bring transparency to the hiring market through evidence-based efficiency scores.
                </p>
            </div>
        )}
      </main>

      <AnimatePresence>
        {activeTab === 'login' && <AuthModal mode="login" onClose={() => setActiveTab('home')} onAuth={handleAuth} />}
        {activeTab === 'signup' && <AuthModal mode="signup" onClose={() => setActiveTab('home')} onAuth={handleAuth} />}
      </AnimatePresence>


      <footer className="py-20 border-t border-slate-200 dark:border-slate-800 mt-20 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-6 grid md:grid-cols-4 gap-12 text-slate-900 dark:text-white">
           <div className="col-span-2">
              <div className="flex items-center gap-2 mb-6 cursor-pointer" onClick={() => setActiveTab(user ? 'dashboard' : 'home')}>
                <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center text-white font-bold text-xs italic">JZ</div>
                <span className="font-extrabold text-lg">JobZoid</span>
              </div>
              <p className="text-slate-500 dark:text-slate-400 max-w-xs text-sm font-medium italic">Making the global hiring market more efficient, one data point at a time.</p>
           </div>
            <div>
              <h4 className="font-bold mb-4 uppercase text-xs tracking-widest text-slate-400">Product</h4>
              <ul className="space-y-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                {user && <li onClick={() => setActiveTab('dashboard')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Dashboard</li>}
                {user && <li onClick={() => setActiveTab('analytics')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Analytics</li>}
                <li onClick={() => setActiveTab('how-it-works')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">How It Works</li>
                {!user && <li onClick={() => setActiveTab('leaderboard')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Fairness Rankings</li>}
                {user && <li onClick={() => setActiveTab('integrations')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Integrations</li>}
                <li className="hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer flex items-center gap-2 transition-colors">Security Protocol <Shield size={14} /></li>
              </ul>
            </div>
           <div>
              <h4 className="font-bold mb-4 uppercase text-xs tracking-widest text-slate-400">Trust</h4>
              <ul className="space-y-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                <li onClick={() => setActiveTab('privacy')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Privacy First Policy</li>
                <li onClick={() => setActiveTab('about')} className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">About</li>
                <li className="hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors">Terms of Service</li>
              </ul>
           </div>
        </div>
      </footer>
    </div>
  )
}

export default App
