package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type appAdminMode string

const (
	appAdminCreate appAdminMode = "create"
	appAdminEdit   appAdminMode = "edit"
	appAdminDelete appAdminMode = "delete"
)

type appAdminStep int

const (
	appStepOwner appAdminStep = iota
	appStepRepo
	appStepForm
	appStepDelete
)

// repoRole is a repo chosen for the app plus its role. Exactly one "frontend" (the config
// `repo`/primary) is required; the rest become `services[]`.
type repoRole struct {
	fullName string
	role     string // "frontend" | "service"
}

func nextRole(r string) string {
	switch r {
	case "frontend":
		return "service"
	default:
		return "frontend"
	}
}

// Form field indices — fixed layout. version & prefix are optional (blank for code apps).
const (
	fName = iota
	fURL
	fVersion
	fTarget
	fShadow
	fReview
	fPrefix
	fSave
)

type appAdminModel struct {
	client       *api.Client
	mode         appAdminMode
	step         appAdminStep
	loading      bool
	err          string
	status       string
	repos        []contract.RepoListItem
	repoCursor   int
	ownerCursor  int // 0 = @me, 1 = the owner/org text input
	formCursor   int
	ownerInput   textinput.Model
	nameInput    textinput.Model
	baseInput    textinput.Model
	versionInput textinput.Model
	prefixInput  textinput.Model
	selected     []repoRole      // repos chosen for this project (multi-select), with roles
	manualInput  textinput.Model // "/" opens this to type a repo slug by hand
	manualActive bool
	repo         string
	target       string
	shadow       bool
	needsReview  bool
	purge        bool
	app          *contract.AppView
	width        int
}

func newOnboardModel(client *api.Client) appAdminModel {
	m := appAdminModel{client: client, mode: appAdminCreate, step: appStepOwner, target: "e2e", shadow: true, needsReview: true}
	m.ownerInput = appTextInput("owner/org", 28)
	m.nameInput = appTextInput("app-name", 28)
	m.baseInput = appTextInput("https://dev.example.com", 42)
	m.versionInput = appTextInput("https://dev.example.com/version (optional)", 42)
	m.prefixInput = appTextInput("qa-bot (optional)", 28)
	m.manualInput = appTextInput("org/repo", 42)
	return m
}

func newEditAppModel(client *api.Client, app contract.AppView) appAdminModel {
	m := newOnboardModel(client)
	m.mode = appAdminEdit
	m.step = appStepForm
	m.app = &app
	m.repo = app.Repo
	m.target = "e2e"
	if app.Code {
		m.target = "code"
	}
	m.shadow = app.Shadow
	m.needsReview = app.NeedsReview
	m.nameInput.SetValue(app.Name)
	m.baseInput.SetValue(app.BaseUrl)
	m.versionInput.SetValue(app.VersionUrl)
	m.prefixInput.SetValue(app.TestDataPrefix)
	m.formCursor = 1
	m.nameInput.Blur()
	m.baseInput.Focus()
	return m
}

func newDeleteAppModel(client *api.Client, app contract.AppView) appAdminModel {
	m := newOnboardModel(client)
	m.mode = appAdminDelete
	m.step = appStepDelete
	m.app = &app
	m.repo = app.Repo
	m.nameInput.SetValue(app.Name)
	return m
}

func appTextInput(placeholder string, width int) textinput.Model {
	t := textinput.New()
	t.Placeholder = placeholder
	t.CharLimit = 300
	t.Width = width
	return t
}

func (m appAdminModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m appAdminModel) Update(msg tea.Msg) (appAdminModel, tea.Cmd) {
	switch msg := msg.(type) {
	case reposLoadedMsg:
		m.loading = false
		m.repos = msg.repos
		m.repoCursor = 0
		m.step = appStepRepo
		m.err = ""
		return m, nil
	case errMsg:
		m.loading = false
		m.err = msg.err.Error()
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		switch m.step {
		case appStepOwner:
			return m.updateOwner(msg)
		case appStepRepo:
			return m.updateRepo(msg)
		case appStepForm:
			return m.updateForm(msg)
		case appStepDelete:
			return m.updateDelete(msg)
		}
	}
	return m, nil
}

func (m appAdminModel) updateOwner(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	switch msg.String() {
	case "up", "down", "tab":
		m.ownerCursor = 1 - m.ownerCursor
		if m.ownerCursor == 1 {
			m.ownerInput.Focus()
			return m, textinput.Blink
		}
		m.ownerInput.Blur()
		return m, nil
	case "enter":
		owner := "@me"
		if m.ownerCursor == 1 {
			owner = strings.TrimSpace(m.ownerInput.Value())
			if owner == "" {
				m.err = "type an owner/org, or pick @me"
				return m, nil
			}
		}
		m.loading = true
		m.err = ""
		return m, listReposCmd(m.client, owner, 1)
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	}
	// Keystrokes only edit the text input when it is the selected choice.
	if m.ownerCursor == 1 {
		var cmd tea.Cmd
		m.ownerInput, cmd = m.ownerInput.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m appAdminModel) renderOwner() string {
	var b strings.Builder
	b.WriteString(hintStyle.Render("whose repositories?") + "\n\n")

	meMarker := "  "
	me := "@me  " + hintStyle.Render("— repos of your github-token user")
	if m.ownerCursor == 0 {
		meMarker = lipgloss.NewStyle().Foreground(colEmber).Render("▸ ")
		me = lipgloss.NewStyle().Bold(true).Render("@me") + "  " + hintStyle.Render("— repos of your github-token user")
	}
	b.WriteString(meMarker + me + "\n")

	inMarker := "  "
	if m.ownerCursor == 1 {
		inMarker = lipgloss.NewStyle().Foreground(colEmber).Render("▸ ")
	}
	b.WriteString(inMarker + labelStyle.Render("owner/org ") + m.ownerInput.View() + "\n")
	return b.String()
}

func (m appAdminModel) updateRepo(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	if m.manualActive {
		return m.updateManualRepo(msg)
	}
	switch msg.String() {
	case "up", "k":
		if m.repoCursor > 0 {
			m.repoCursor--
		}
	case "down", "j":
		if m.repoCursor < len(m.repos)-1 {
			m.repoCursor++
		}
	case " ":
		if len(m.repos) > 0 {
			m.toggleSelected(m.repos[m.repoCursor].FullName)
		}
	case "r":
		if len(m.repos) > 0 {
			m.cycleRoleUnderCursor(m.repos[m.repoCursor].FullName)
		}
	case "/":
		m.manualActive = true
		m.manualInput.Focus()
		return m, textinput.Blink
	case "enter":
		if err := m.validateSelection(); err != "" {
			m.err = err
			return m, nil
		}
		m.err = ""
		m.repo = m.frontendRepo()
		m.nameInput.SetValue(suggestAppName(m.repo))
		m.baseInput.SetValue("")
		m.nameInput.Focus()
		m.step = appStepForm
	case "esc":
		m.step = appStepOwner
		m.ownerInput.Focus()
	}
	return m, nil
}

// toggleSelected adds the repo (defaulting the FIRST pick to "frontend", later picks to "service")
// or removes it if already selected.
func (m *appAdminModel) toggleSelected(full string) {
	for i, s := range m.selected {
		if s.fullName == full {
			m.selected = append(m.selected[:i], m.selected[i+1:]...)
			return
		}
	}
	role := "service"
	if m.frontendRepo() == "" {
		role = "frontend"
	}
	m.selected = append(m.selected, repoRole{fullName: full, role: role})
}

func (m *appAdminModel) cycleRoleUnderCursor(full string) {
	for i := range m.selected {
		if m.selected[i].fullName == full {
			m.selected[i].role = nextRole(m.selected[i].role)
			return
		}
	}
}

func (m appAdminModel) frontendRepo() string {
	for _, s := range m.selected {
		if s.role == "frontend" {
			return s.fullName
		}
	}
	return ""
}

func (m appAdminModel) validateSelection() string {
	if len(m.selected) == 0 {
		return "select at least one repository (space)"
	}
	fronts := 0
	for _, s := range m.selected {
		if s.role == "frontend" {
			fronts++
		}
	}
	if fronts != 1 {
		return "exactly one repo must be the frontend (press r to set the role)"
	}
	return ""
}

// updateManualRepo handles the "/" typed-slug entry: enter adds the slug (frontend if none yet,
// else service), esc cancels. Any other key edits the input.
func (m appAdminModel) updateManualRepo(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	switch msg.String() {
	case "enter":
		slug := strings.TrimSpace(m.manualInput.Value())
		if slug != "" {
			m.toggleSelected(slug)
		}
		m.manualInput.SetValue("")
		m.manualActive = false
		return m, nil
	case "esc":
		m.manualInput.SetValue("")
		m.manualActive = false
		return m, nil
	}
	var cmd tea.Cmd
	m.manualInput, cmd = m.manualInput.Update(msg)
	return m, cmd
}

func (m appAdminModel) updateForm(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	case "tab", "down", "j":
		m.moveFormFocus(1)
		return m, textinput.Blink
	case "shift+tab", "up", "k":
		m.moveFormFocus(-1)
		return m, textinput.Blink
	case " ":
		m.toggleFormValue()
		return m, nil
	case "enter":
		if m.formCursor < fSave {
			m.moveFormFocus(1)
			return m, textinput.Blink
		}
		return m.save()
	}
	var cmd tea.Cmd
	switch m.formCursor {
	case fName:
		if m.mode != appAdminEdit {
			m.nameInput, cmd = m.nameInput.Update(msg)
		}
	case fURL:
		m.baseInput, cmd = m.baseInput.Update(msg)
	case fVersion:
		m.versionInput, cmd = m.versionInput.Update(msg)
	case fPrefix:
		m.prefixInput, cmd = m.prefixInput.Update(msg)
	}
	return m, cmd
}

func (m *appAdminModel) moveFormFocus(delta int) {
	minCursor := 0
	if m.mode == appAdminEdit {
		minCursor = 1 // the name is fixed once created
	}
	m.formCursor += delta
	if m.formCursor < minCursor {
		m.formCursor = fSave
	}
	if m.formCursor > fSave {
		m.formCursor = minCursor
	}
	m.nameInput.Blur()
	m.baseInput.Blur()
	m.versionInput.Blur()
	m.prefixInput.Blur()
	switch m.formCursor {
	case fName:
		if m.mode != appAdminEdit {
			m.nameInput.Focus()
		}
	case fURL:
		m.baseInput.Focus()
	case fVersion:
		m.versionInput.Focus()
	case fPrefix:
		m.prefixInput.Focus()
	}
}

func (m *appAdminModel) toggleFormValue() {
	switch m.formCursor {
	case fTarget:
		if m.target == "e2e" {
			m.target = "code"
		} else {
			m.target = "e2e"
		}
	case fShadow:
		m.shadow = !m.shadow
	case fReview:
		m.needsReview = !m.needsReview
	}
}

func (m appAdminModel) save() (appAdminModel, tea.Cmd) {
	name := strings.TrimSpace(m.nameInput.Value())
	if m.mode == appAdminEdit {
		name = m.appName()
	}
	if name == "" {
		m.err = "name is required"
		return m, nil
	}
	baseURL := strings.TrimSpace(m.baseInput.Value())
	if m.target == "e2e" && baseURL == "" {
		m.err = "base url is required for e2e apps"
		return m, nil
	}
	versionURL := strings.TrimSpace(m.versionInput.Value())
	prefix := strings.TrimSpace(m.prefixInput.Value())
	m.loading = true
	m.err = ""
	if m.mode == appAdminEdit {
		return m, updateAppCmd(m.client, m.appName(), name, m.repo, baseURL, versionURL, m.target, prefix, m.shadow, m.needsReview)
	}
	return m, createAppCmd(m.client, m.repo, name, baseURL, versionURL, m.target, prefix, m.shadow, m.needsReview)
}

func (m appAdminModel) appName() string {
	if m.app != nil {
		return m.app.Name
	}
	return strings.TrimSpace(m.nameInput.Value())
}

func (m appAdminModel) updateDelete(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	switch msg.String() {
	case " ":
		m.purge = !m.purge
	case "enter", "y":
		m.loading = true
		return m, deleteAppCmd(m.client, m.appName(), m.purge)
	case "esc", "n":
		return m, func() tea.Msg { return backMsg{} }
	}
	return m, nil
}

func (m appAdminModel) View() string {
	var b strings.Builder
	title := "onboard app"
	if m.mode == appAdminEdit {
		title = "edit app"
	} else if m.mode == appAdminDelete {
		title = "delete app"
	}
	b.WriteString(accentRule(contentWidth(m.width), title, m.wizardCrumb()) + "\n\n")
	if m.loading {
		b.WriteString(infoStyle.Render("loading…") + "\n")
	} else {
		switch m.step {
		case appStepOwner:
			b.WriteString(m.renderOwner())
		case appStepRepo:
			b.WriteString(m.renderRepos())
		case appStepForm:
			b.WriteString(m.renderForm())
		case appStepDelete:
			b.WriteString(m.renderDelete())
		}
	}
	if m.err != "" {
		b.WriteString("\n" + errorStyle.Render("✗ "+m.err))
	}
	if m.status != "" {
		b.WriteString("\n" + okStyle.Render(m.status))
	}
	b.WriteString("\n" + hintStyle.Render(m.footerHint()))
	return screenStyle.Render(b.String())
}

// wizardCrumb is the onboarding stepper (owner › repo › configure). Empty for
// edit/delete, which start straight at the form / confirmation.
func (m appAdminModel) wizardCrumb() string {
	if m.mode != appAdminCreate {
		return ""
	}
	steps := []struct {
		at    appAdminStep
		label string
	}{
		{appStepOwner, "owner"},
		{appStepRepo, "repo"},
		{appStepForm, "configure"},
	}
	var parts []string
	for _, s := range steps {
		st := hintStyle
		switch {
		case s.at == m.step:
			st = okStyle.Bold(true)
		case s.at < m.step:
			st = labelStyle
		}
		parts = append(parts, st.Render(s.label))
	}
	return hintStyle.Render(strings.Join(parts, " › "))
}

// footerHint is the single, step-aware key legend for this screen — the only place
// hints are rendered, so each binding (esc included) appears exactly once.
func (m appAdminModel) footerHint() string {
	switch m.step {
	case appStepOwner:
		return "↑↓ choose · enter load repos · esc back"
	case appStepRepo:
		return "↑↓ choose · enter form · esc owner"
	case appStepForm:
		return "tab move · space toggle · enter next/save · esc back"
	case appStepDelete:
		return "space toggle purge · enter delete · esc cancel"
	default:
		return "esc back"
	}
}

func (m appAdminModel) renderRepos() string {
	if len(m.repos) == 0 {
		return hintStyle.Render("no repos found") + "\n"
	}
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(labelRule(w, "repos", hintStyle.Render(pluralize(len(m.repos), "repo", "repos"))) + "\n")
	for i, repo := range m.repos {
		privacy := "public"
		if repo.Private {
			privacy = "private"
		}
		if i == m.repoCursor {
			b.WriteString(selectedRow(w, "", repo.FullName, privacy) + "\n")
		} else {
			b.WriteString(normalRow(w, "", repo.FullName, privacy) + "\n")
		}
	}
	return b.String()
}

// yesNo renders a boolean as a styled yes/no, matching the design language rather than
// leaking Go's raw true/false into the form.
func yesNo(b bool) string {
	if b {
		return okStyle.Render("yes")
	}
	return hintStyle.Render("no")
}

func (m appAdminModel) renderForm() string {
	nameRow := labelStyle.Render("name    ") + m.nameInput.View()
	if m.mode == appAdminEdit {
		nameRow = labelStyle.Render("name    ") + hintStyle.Render(m.appName())
	}
	rows := []string{
		nameRow,
		labelStyle.Render("url     ") + m.baseInput.View(),
		labelStyle.Render("version ") + m.versionInput.View(),
		labelStyle.Render("target  ") + m.target,
		labelStyle.Render("shadow  ") + yesNo(m.shadow),
		labelStyle.Render("review  ") + yesNo(m.needsReview),
		labelStyle.Render("prefix  ") + m.prefixInput.View(),
		"save",
	}
	var b strings.Builder
	b.WriteString(labelStyle.Render("repo    ") + m.repo + "\n")
	for i, row := range rows {
		marker := "  "
		text := row
		if i == m.formCursor {
			marker = lipgloss.NewStyle().Foreground(colEmber).Render("▸ ")
			if i == fTarget || i == fShadow || i == fReview || i == fSave {
				text = lipgloss.NewStyle().Bold(true).Render(text)
			}
		}
		b.WriteString(marker + text + "\n")
	}
	// An inline explanation of the focused field, so onboarding is self-explanatory
	// without reaching for the docs.
	if help := appFieldHelp(m.formCursor); help != "" {
		b.WriteString("\n" + hintStyle.Render(help))
	}
	return b.String()
}

// appFieldHelp is the one-line explanation shown under the form for the focused field.
func appFieldHelp(cursor int) string {
	switch cursor {
	case fName:
		return "a short id for this app — lowercase, used in commands and config paths"
	case fURL:
		return "the DEV base URL the suite runs against (required for e2e) — where the deployed app lives"
	case fVersion:
		return "optional /version endpoint; when set, the deploy gate waits until DEV serves the commit"
	case fTarget:
		return "e2e = browser tests against DEV · code = source-logic tests in the repo's own framework"
	case fShadow:
		return "shadow = run the full pipeline but publish nothing — safe to onboard without touching the repo"
	case fReview:
		return "require the independent reviewer agent to approve before a suite is committed via PR"
	case fPrefix:
		return "optional prefix the agent uses to namespace any test data it creates"
	case fSave:
		return "write config/apps/<name>.yaml and start watching this repo"
	}
	return ""
}

func (m appAdminModel) renderDelete() string {
	purgeBox, purgeWord, note := "☐", labelStyle.Render("purge"), hintStyle.Render("config entry only — mirrors & run history are kept")
	if m.purge {
		purgeBox, purgeWord, note = "☑", errorStyle.Render("purge"), errorStyle.Render("also wipes mirrors & run history — irreversible")
	}
	var b strings.Builder
	b.WriteString(errorStyle.Bold(true).Render("delete "+m.appName()+" ?") + "\n")
	if m.repo != "" {
		b.WriteString(labelStyle.Render(m.repo) + "\n")
	}
	b.WriteString("\n")
	b.WriteString(lipgloss.NewStyle().Foreground(colEmber).Render("▸ ") + purgeBox + " " + purgeWord + "\n")
	b.WriteString("  " + note)
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colError).
		Padding(0, 2).
		Render(b.String())
	return box + "\n"
}

type onboardSelectedMsg struct{}
type editAppMsg struct{ app contract.AppView }
type deleteAppMsg struct{ app contract.AppView }
type onboardBoundariesMsg struct{ app string }
type reposLoadedMsg struct{ repos []contract.RepoListItem }
type appsChangedMsg struct {
	apps   []contract.AppView
	status string
}

func listReposCmd(c *api.Client, owner string, page int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		res, err := c.ListRepos(ctx, owner, page)
		if err != nil {
			return errMsg{err}
		}
		return reposLoadedMsg{repos: res.Repos}
	}
}

func createAppCmd(c *api.Client, repo, name, baseURL, versionURL, target, prefix string, shadow, needsReview bool) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		input := contract.CreateAppInput{
			Repo:           repo,
			Name:           &name,
			BaseUrl:        stringPtrOrNil(baseURL),
			VersionUrl:     stringPtrOrNil(versionURL),
			TestDataPrefix: stringPtrOrNil(prefix),
			Shadow:         &shadow,
			NeedsReview:    &needsReview,
		}
		t := contract.CreateAppInputTarget(target)
		input.Target = &t
		if _, err := c.CreateApp(ctx, input); err != nil {
			return errMsg{err}
		}
		return reloadAppsMsg(c, ctx, fmt.Sprintf("%s onboarded", name))
	}
}

func updateAppCmd(c *api.Client, originalName, name, repo, baseURL, versionURL, target, prefix string, shadow, needsReview bool) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		input := contract.UpdateAppInput{
			Repo:           stringPtrOrNil(repo),
			BaseUrl:        stringPtrOrNil(baseURL),
			VersionUrl:     stringPtrOrNil(versionURL),
			TestDataPrefix: stringPtrOrNil(prefix),
			Shadow:         &shadow,
			NeedsReview:    &needsReview,
		}
		t := contract.UpdateAppInputTarget(target)
		input.Target = &t
		if _, err := c.UpdateApp(ctx, originalName, input); err != nil {
			return errMsg{err}
		}
		return reloadAppsMsg(c, ctx, fmt.Sprintf("%s updated", name))
	}
}

func deleteAppCmd(c *api.Client, name string, purge bool) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := c.DeleteApp(ctx, name, purge); err != nil {
			return errMsg{err}
		}
		return reloadAppsMsg(c, ctx, fmt.Sprintf("%s deleted", name))
	}
}

func reloadAppsMsg(c *api.Client, _ context.Context, status string) tea.Msg {
	// The create/delete already consumed most of the caller's deadline; give the reload its
	// own budget so a slow mutation doesn't make the refresh time out and look like a failure.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	apps, err := c.ListApps(ctx)
	if err != nil {
		return errMsg{err}
	}
	return appsChangedMsg{apps: apps, status: status}
}

func stringPtrOrNil(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func suggestAppName(repo string) string {
	parts := strings.Split(strings.Trim(repo, "/"), "/")
	if len(parts) == 0 {
		return repo
	}
	name := parts[len(parts)-1]
	name = strings.ToLower(name)
	name = strings.ReplaceAll(name, "_", "-")
	return name
}
