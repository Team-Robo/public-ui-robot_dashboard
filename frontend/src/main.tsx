import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { migrateNamingPreferences } from './namingMigration'

try { migrateNamingPreferences(window.localStorage) } catch {
  // Storage disabled/full: keep the existing preferences and render normally.
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
