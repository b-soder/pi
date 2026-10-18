-- Pi embedded Neovim integration: sync drafts/cursor, submit, and route controls over RPC.
local function pi_channel()
  local channel = vim.g.pi_channel
  if type(channel) ~= "number" then
    vim.notify("Pi commands are only available in Pi's embedded Neovim viewport", vim.log.levels.WARN)
    return nil
  end
  return channel
end

local function pi_cursor_screen_position(cursor)
  local line = cursor[1] - 1
  local view_top = vim.fn.winsaveview().topline - 1
  local row = math.max(0, line - view_top)
  if line > view_top and vim.api.nvim_win_text_height then
    row = vim.api.nvim_win_text_height(0, { start_row = view_top, end_row = line - 1 }).all
  end
  local width = math.max(1, vim.api.nvim_win_get_width(0))
  local virtual_col = math.max(0, vim.fn.virtcol({ cursor[1], cursor[2] + 1 }) - 1)
  return { row + math.floor(virtual_col / width), virtual_col % width }
end

local function pi_send_cursor()
  local channel = vim.g.pi_channel
  if type(channel) ~= "number" then return false end
  local cursor = vim.api.nvim_win_get_cursor(0)
  vim.rpcnotify(channel, "pi_cursor", cursor, pi_cursor_screen_position(cursor))
  return true
end

local function pi_send_draft()
  local channel = vim.g.pi_channel
  if type(channel) ~= "number" then return false end
  local cursor = vim.api.nvim_win_get_cursor(0)
  vim.rpcnotify(
    channel,
    "pi_draft",
    vim.api.nvim_buf_get_lines(0, 0, -1, true),
    vim.api.nvim_get_mode().mode,
    cursor,
    pi_cursor_screen_position(cursor)
  )
  return true
end

local pi_sync_generation = 0
local function pi_sync_draft()
  if type(vim.g.pi_channel) ~= "number" then return end
  pi_sync_generation = pi_sync_generation + 1
  local generation = pi_sync_generation
  vim.defer_fn(function()
    if generation == pi_sync_generation then pi_send_draft() end
  end, 120)
end

vim.api.nvim_create_augroup("PiEmbeddedInput", { clear = true })
vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "ModeChanged" }, {
  group = "PiEmbeddedInput",
  callback = pi_sync_draft,
})
vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
  group = "PiEmbeddedInput",
  callback = pi_send_cursor,
})

vim.api.nvim_create_user_command("PiFlush", function()
  local channel = pi_channel()
  if not channel then return end
  vim.rpcnotify(channel, "pi_submit", vim.api.nvim_buf_get_lines(0, 0, -1, true))
  vim.api.nvim_buf_set_lines(0, 0, -1, true, { "" })
  pi_sync_draft()
end, { force = true })

local function pi_flush_from_insert()
  vim.cmd.stopinsert()
  vim.cmd.PiFlush()
  vim.schedule(function()
    if vim.api.nvim_get_mode().mode ~= "i" then vim.cmd.startinsert() end
  end)
end

vim.keymap.set("i", "<D-CR>", pi_flush_from_insert, { silent = true })
vim.keymap.set({ "n", "v" }, "<D-CR>", "<Cmd>PiFlush<CR>", { silent = true })

-- tmux decodes iTerm2's Super+Enter CSI-u event as Meta+Enter.
if vim.env.TMUX then
  local function replay_meta_enter()
    local key = vim.api.nvim_replace_termcodes("<A-CR>", true, false, true)
    vim.api.nvim_feedkeys(key, "n", false)
  end

  vim.keymap.set("i", "<A-CR>", function()
    if type(vim.g.pi_channel) ~= "number" then
      replay_meta_enter()
      return
    end
    pi_flush_from_insert()
  end, { silent = true })
  vim.keymap.set({ "n", "v" }, "<A-CR>", function()
    if type(vim.g.pi_channel) ~= "number" then
      replay_meta_enter()
      return
    end
    vim.cmd.PiFlush()
  end, { silent = true })
end

vim.api.nvim_create_user_command("PiQuit", function()
  local channel = pi_channel()
  if channel then
    pi_send_draft()
    vim.rpcnotify(channel, "pi_quit")
  end
end, { force = true })

vim.keymap.set("c", "<CR>", function()
  local command = vim.fn.getcmdline()
  if command:match("^%s*q!?%s*$") and type(vim.g.pi_channel) == "number" then
    return "<C-c><Cmd>PiQuit<CR>"
  end
  return "<CR>"
end, { expr = true, replace_keycodes = true })
