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
	formCursor   int
	ownerInput   textinput.Model
	nameInput    textinput.Model
	baseInput    textinput.Model
	versionInput textinput.Model
	prefixInput  textinput.Model
	repo         string
	target       string
	shadow       bool
	needsReview  bool
	purge        bool
	app          *contract.AppView
}

func newOnboardModel(client *api.Client) appAdminModel {
	m := appAdminModel{client: client, mode: appAdminCreate, step: appStepOwner, target: "e2e", shadow: true, needsReview: true}
	m.ownerInput = appTextInput("owner/org", 28)
	m.ownerInput.Focus()
	m.nameInput = appTextInput("app-name", 28)
	m.baseInput = appTextInput("https://dev.example.com", 42)
	m.versionInput = appTextInput("https://dev.example.com/version (optional)", 42)
	m.prefixInput = appTextInput("qa-bot (optional)", 28)
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
	case "enter":
		owner := strings.TrimSpace(m.ownerInput.Value())
		if owner == "" {
			m.err = "owner is required"
			return m, nil
		}
		m.loading = true
		m.err = ""
		return m, listReposCmd(m.client, owner, 1)
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	}
	var cmd tea.Cmd
	m.ownerInput, cmd = m.ownerInput.Update(msg)
	return m, cmd
}

func (m appAdminModel) updateRepo(msg tea.KeyMsg) (appAdminModel, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		if m.repoCursor > 0 {
			m.repoCursor--
		}
	case "down", "j":
		if m.repoCursor < len(m.repos)-1 {
			m.repoCursor++
		}
	case "enter":
		if len(m.repos) == 0 {
			return m, nil
		}
		m.repo = m.repos[m.repoCursor].FullName
		m.nameInput.SetValue(suggestAppName(m.repo))
		m.baseInput.SetValue(fmt.Sprintf("https://github.com/%s", m.repo))
		m.nameInput.Focus()
		m.baseInput.Blur()
		m.step = appStepForm
	case "esc":
		m.step = appStepOwner
		m.ownerInput.Focus()
	}
	return m, nil
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
	b.WriteString(titleStyle.Render(title) + "  " + m.wizardCrumb() + "\n\n")
	if m.loading {
		b.WriteString(infoStyle.Render("loading…") + "\n")
	} else {
		switch m.step {
		case appStepOwner:
			b.WriteString(labelStyle.Render("owner ") + m.ownerInput.View() + "\n")
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
		return "enter search repos · esc back"
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
	var b strings.Builder
	b.WriteString(infoStyle.Render("repos") + "\n")
	for i, repo := range m.repos {
		marker := "  "
		name := repo.FullName
		if i == m.repoCursor {
			marker = okStyle.Render("▸ ")
			name = lipgloss.NewStyle().Bold(true).Render(name)
		}
		privacy := "public"
		if repo.Private {
			privacy = "private"
		}
		b.WriteString(fmt.Sprintf("%s%s  %s\n", marker, name, hintStyle.Render(privacy)))
	}
	return b.String()
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
		fmt.Sprintf("target   %s", m.target),
		fmt.Sprintf("shadow   %t", m.shadow),
		fmt.Sprintf("review   %t", m.needsReview),
		labelStyle.Render("prefix  ") + m.prefixInput.View(),
		"save",
	}
	var b strings.Builder
	b.WriteString(labelStyle.Render("repo    ") + m.repo + "\n")
	for i, row := range rows {
		marker := "  "
		text := row
		if i == m.formCursor {
			marker = okStyle.Render("▸ ")
			if i == fTarget || i == fShadow || i == fReview || i == fSave {
				text = lipgloss.NewStyle().Bold(true).Render(text)
			}
		}
		b.WriteString(marker + text + "\n")
	}
	return b.String()
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
	b.WriteString(okStyle.Render("▸ ") + purgeBox + " " + purgeWord + "\n")
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

func reloadAppsMsg(c *api.Client, ctx context.Context, status string) tea.Msg {
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
